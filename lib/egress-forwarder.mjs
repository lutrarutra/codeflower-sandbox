// The proxy at 127.0.0.1:3128 for an isolated sandbox that has no bridge (reproduce.sh): it
// forwards to the app's egress socket, which lets through only the allowed hosts.
import { startEgressForwarder } from '/opt/codeflower/acp-ws/src/egress.js';

const socket = process.env.CODEFLOWER_EGRESS_SOCKET;
if (!socket) {
  console.error('CODEFLOWER_EGRESS_SOCKET is not set');
  process.exit(1);
}
await startEgressForwarder(socket);
