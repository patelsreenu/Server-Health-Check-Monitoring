'use strict';

const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

function ec2(credentials, region)    { return new EC2Client({ region, credentials }); }
function cw(credentials, region)     { return new CloudWatchClient({ region, credentials }); }
function cwLogs(credentials, region) { return new CloudWatchLogsClient({ region, credentials }); }

async function getMetric(client, instanceId, metricName, stat = 'Average', periodSec = 300) {
  const end = new Date(), start = new Date(end - periodSec * 1000);
  try {
    const r = await client.send(new GetMetricStatisticsCommand({
      Namespace: 'AWS/EC2', MetricName: metricName,
      Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
      StartTime: start, EndTime: end, Period: periodSec, Statistics: [stat]
    }));
    if (!r.Datapoints?.length) return null;
    return r.Datapoints.sort((a, b) => b.Timestamp - a.Timestamp)[0][stat];
  } catch { return null; }
}

// Page 1 — instance state only (no metrics)
async function getFleetStatus(credentials, region) {
  const client = ec2(credentials, region);
  let NextToken;
  const instances = [];
  do {
    const r = await client.send(new DescribeInstancesCommand({ NextToken, MaxResults: 100 }));
    for (const res of (r.Reservations || [])) {
      for (const inst of (res.Instances || [])) {
        instances.push({
          id:        inst.InstanceId,
          name:      inst.Tags?.find(t => t.Key === 'Name')?.Value || inst.InstanceId,
          provider:  'AWS',
          state:     inst.State?.Name,
          upDown:    inst.State?.Name === 'running' ? 'up' : 'down',
          privateIp: inst.PrivateIpAddress || null,
          region,
          subnetId:  inst.SubnetId || null,
          vpcId:     inst.VpcId || null
        });
      }
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return instances;
}

// Page 2 — lightweight metrics per instance
async function getSubnetHealth(instanceIds, credentials, region) {
  const ec2Client = ec2(credentials, region);
  const cwClient  = cw(credentials, region);

  const r = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
  const instances = r.Reservations?.flatMap(res => res.Instances || []) || [];

  return Promise.all(instances.map(async inst => {
    const cpu = inst.State?.Name === 'running'
      ? await getMetric(cwClient, inst.InstanceId, 'CPUUtilization') : null;
    const nameTag = inst.Tags?.find(t => t.Key === 'Name')?.Value;
    return {
      id:           inst.InstanceId,
      name:         nameTag || inst.InstanceId,
      provider:     'AWS',
      state:        inst.State?.Name,
      upDown:       inst.State?.Name === 'running' ? 'up' : 'down',
      status:       inst.State?.Name === 'running' ? (cpu > 90 ? 'critical' : cpu > 85 ? 'warning' : 'healthy') : 'stopped',
      privateIp:    inst.PrivateIpAddress || null,
      instanceType: inst.InstanceType,
      metrics:      { cpu: cpu != null ? Math.round(cpu * 10) / 10 : null }
    };
  }));
}

// Page 3 — full metrics
async function getServerDetail(server, credentials, region) {
  const cwClient = cw(credentials, region);
  const [cpu, netIn, netOut] = await Promise.all([
    getMetric(cwClient, server.id, 'CPUUtilization'),
    getMetric(cwClient, server.id, 'NetworkIn'),
    getMetric(cwClient, server.id, 'NetworkOut')
  ]);
  return {
    ...server,
    metrics: {
      cpu:        cpu  != null ? Math.round(cpu  * 10) / 10 : null,
      netInKB:    netIn  != null ? Math.round(netIn  / 1024) : null,
      netOutKB:   netOut != null ? Math.round(netOut / 1024) : null
    }
  };
}

async function getLogs(server, credentials, region, lines = 100) {
  const client = cwLogs(credentials, region);
  const logGroupName = server.logGroup || `/aws/ec2/${server.id}`;
  try {
    const streamsResult = await client.send(new DescribeLogStreamsCommand({
      logGroupName, orderBy: 'LastEventTime', descending: true, limit: 1
    }));
    if (!streamsResult.logStreams?.length) {
      return { lines: [], source: 'cloudwatch', message: 'No log streams found.' };
    }
    const eventsResult = await client.send(new GetLogEventsCommand({
      logGroupName, logStreamName: streamsResult.logStreams[0].logStreamName,
      limit: Math.min(lines, 1000), startFromHead: false
    }));
    return {
      source: 'cloudwatch', logGroup: logGroupName,
      lines: (eventsResult.events || []).map(e => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: e.message.replace(/\n$/, '')
      }))
    };
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return { lines: [], source: 'cloudwatch', message: `Log group not found: ${logGroupName}` };
    }
    throw err;
  }
}

module.exports = { getFleetStatus, getSubnetHealth, getServerDetail, getLogs };
