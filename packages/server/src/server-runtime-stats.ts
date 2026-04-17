/** WebSocket 连接计数（与进程 uptime 一起供管理 API 使用）。 */

let connectedWebSocketClients = 0;

export function recordWebSocketConnection(): () => void {
  connectedWebSocketClients++;
  return () => {
    connectedWebSocketClients--;
  };
}

export function getConnectedWebSocketClients(): number {
  return connectedWebSocketClients;
}

export function getProcessUptimeSeconds(): number {
  return Math.floor(process.uptime());
}
