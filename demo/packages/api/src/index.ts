import { formatDate } from "@demo/shared";

export function createServer() {
  return {
    start(port: number) {
      console.log(`API listening on ${port} (${formatDate(new Date())})`);
    },
  };
}
