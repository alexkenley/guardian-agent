import { BrokerClient } from '../broker/broker-client.js';
import { BrokeredWorkerSession } from './worker-session.js';

async function main(): Promise<void> {
  const client = new BrokerClient({
    inputStream: process.stdin,
    outputStream: process.stdout,
    capabilityToken: process.env.CAPABILITY_TOKEN || '',
  });

  const session = new BrokeredWorkerSession(client);
  let heartbeat: NodeJS.Timeout | undefined;

  client.setNotificationHandler((notification) => {
    if (notification.method === 'worker.initialize') {
      const tools = Array.isArray(notification.params.alwaysLoadedTools)
        ? notification.params.alwaysLoadedTools
        : [];
      client.setAlwaysLoadedTools(tools);
      client.sendNotification('worker.ready', {
        agentId: String(notification.params.agentId ?? 'unknown'),
      });

      if (!heartbeat) {
        heartbeat = setInterval(() => {
          client.sendNotification('worker.heartbeat', {
            uptimeMs: Math.round(process.uptime() * 1000),
            memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          });
        }, 30_000);
      }
      return;
    }

    if (notification.method === 'worker.shutdown') {
      if (heartbeat) clearInterval(heartbeat);
      process.exit(0);
    }

    if (notification.method === 'message.handle') {
      void session.handleMessage(notification.params as never)
        .then((result) => {
          client.sendNotification('message.response', {
            content: result.content,
            metadata: result.metadata,
          });
        })
        .catch((error) => {
          client.sendNotification('message.response', {
            content: error instanceof Error ? error.message : String(error),
            metadata: { error: true },
          });
        });
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
