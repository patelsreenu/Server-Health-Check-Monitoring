'use strict';

const { ComputeManagementClient } = require('@azure/arm-compute');
const { MetricsQueryClient }      = require('@azure/monitor-query');
const { ClientSecretCredential }  = require('@azure/identity');

function getCredential(clouds) {
  const az = clouds.azure;
  const tenantId = process.env.AZURE_TENANT_ID || az.tenantId;
  const clientId = process.env.AZURE_CLIENT_ID || az.clientId;
  const clientSecret = process.env.AZURE_CLIENT_SECRET || az.clientSecret;
  if (!tenantId || !clientId || !clientSecret) return null;
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

function powerState(vm) {
  const statuses = vm.instanceView?.statuses || [];
  const ps = statuses.find(s => s.code?.startsWith('PowerState/'));
  return ps?.code?.replace('PowerState/', '') || 'unknown';
}

async function getFleetStatus(credential, subscriptionId) {
  const client = new ComputeManagementClient(credential, subscriptionId);
  const vms = [];
  for await (const vm of client.virtualMachines.listAll({ expand: 'instanceView' })) {
    const state = powerState(vm);
    vms.push({
      id:            vm.id,
      name:          vm.name,
      provider:      'Azure',
      state,
      upDown:        state === 'running' ? 'up' : 'down',
      location:      vm.location,
      resourceGroup: vm.id?.split('/')[4] || '',
      vmSize:        vm.hardwareProfile?.vmSize
    });
  }
  return vms;
}

async function getServerDetail(server, credential) {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID || server.subscriptionId;
  const compute = new ComputeManagementClient(credential, subscriptionId);
  const metricsClient = new MetricsQueryClient(credential);

  const vm = await compute.virtualMachines.get(server.resourceGroup, server.vmName, { expand: 'instanceView' });
  const state = powerState(vm);

  let cpu = null;
  try {
    const end = new Date(), start = new Date(end - 5 * 60 * 1000);
    const r = await metricsClient.queryResource(vm.id, ['Percentage CPU', 'Available Memory Bytes'], {
      granularity: 'PT1M', timespan: { startTime: start, endTime: end }
    });
    const cpuData = r.metrics[0]?.timeseries?.[0]?.data;
    if (cpuData?.length) {
      const last = [...cpuData].reverse().find(d => d.average != null);
      if (last) cpu = Math.round(last.average * 10) / 10;
    }
  } catch {}

  let status = 'unknown';
  if (state === 'running') status = cpu > 90 ? 'critical' : cpu > 85 ? 'warning' : 'healthy';
  else if (state === 'stopped' || state === 'deallocated') status = 'stopped';

  return { ...server, provider: 'Azure', state, status, metrics: { cpu }, location: vm.location };
}

module.exports = { getFleetStatus, getServerDetail, getCredential };
