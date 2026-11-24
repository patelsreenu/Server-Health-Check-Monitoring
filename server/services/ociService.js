'use strict';

let ociCore, ociMonitoring, ociCommon;
try {
  ociCore       = require('oci-core');
  ociMonitoring = require('oci-monitoring');
  ociCommon     = require('oci-common');
} catch {}

function getProvider(clouds) {
  if (!ociCommon) return null;
  const configFile = process.env.OCI_CONFIG_FILE || clouds?.oci?.configFile || undefined;
  try {
    return configFile
      ? new ociCommon.ConfigFileAuthenticationDetailsProvider(configFile)
      : new ociCommon.ConfigFileAuthenticationDetailsProvider();
  } catch { return null; }
}

async function getFleetStatus(clouds) {
  if (!ociCore || !ociCommon) return [];
  const provider = getProvider(clouds);
  if (!provider) return [];

  const compartmentId = process.env.OCI_COMPARTMENT_ID || clouds?.oci?.compartmentId;
  if (!compartmentId) return [];

  const client = new ociCore.ComputeClient({ authenticationDetailsProvider: provider });
  try {
    const r = await client.listInstances({ compartmentId });
    return (r.items || []).map(inst => ({
      id:           inst.id,
      name:         inst.displayName,
      provider:     'OCI',
      state:        inst.lifecycleState?.toLowerCase(),
      upDown:       inst.lifecycleState?.toLowerCase() === 'running' ? 'up' : 'down',
      region:       inst.region,
      availabilityDomain: inst.availabilityDomain,
      shape:        inst.shape
    }));
  } catch { return []; }
}

async function getServerDetail(server, clouds) {
  if (!ociCore) throw new Error('OCI SDK not installed');
  const provider = getProvider(clouds);
  if (!provider) throw new Error('OCI credentials not configured');

  const client = new ociCore.ComputeClient({ authenticationDetailsProvider: provider });
  client.region = server.region;

  const r = await client.getInstance({ instanceId: server.id });
  const state = r.instance.lifecycleState?.toLowerCase();

  let cpu = null;
  try {
    const monClient = new ociMonitoring.MonitoringClient({ authenticationDetailsProvider: provider });
    monClient.region = server.region;
    const compartmentId = server.compartmentId || process.env.OCI_COMPARTMENT_ID;
    const end = new Date(), start = new Date(end - 5 * 60 * 1000);
    const metricsResult = await monClient.summarizeMetricsData({
      compartmentId,
      summarizeMetricsDataDetails: {
        namespace: 'oci_computeagent',
        query: `CpuUtilization[1m]{resourceId = "${server.id}"}.mean()`,
        startTime: start.toISOString(), endTime: end.toISOString()
      }
    });
    const pts = metricsResult.items?.[0]?.aggregatedDatapoints;
    if (pts?.length) cpu = pts.slice(-1)[0]?.value != null ? Math.round(pts.slice(-1)[0].value * 10) / 10 : null;
  } catch {}

  const status = state === 'running' ? (cpu > 90 ? 'critical' : cpu > 85 ? 'warning' : 'healthy')
               : state === 'stopped' ? 'stopped' : 'unknown';

  return { ...server, provider: 'OCI', state, status, metrics: { cpu } };
}

module.exports = { getFleetStatus, getServerDetail };
