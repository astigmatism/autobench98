// wu-test.mjs
import { SerialPort } from "serialport";

const PORT_PATH = "/dev/cu.usbserial-A7005IDU";
const BAUD_RATE = 115200;
const REQUEST = "#V,3;"; // Watts Up? version query

console.log(`Opening port: ${PORT_PATH} @ ${BAUD_RATE} baud`);

const port = new SerialPort({
  path: PORT_PATH,
  baudRate: BAUD_RATE,
  autoOpen: false,
});

let buffer = "";
let totalBytes = 0;

port.on("error", (err) => {
  console.error("Port error:", err.message);
});

port.on("data", (data) => {
  totalBytes += data.length;

  // Accumulate into a line buffer and split on CR/LF
  buffer += data.toString("utf8");
  const parts = buffer.split(/\r?\n/);
  buffer = parts.pop() ?? "";

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    console.log(`[RX line ]: "${trimmed}"`);

    // Show raw hex of this line too (for debugging odd characters)
    const bytes = Buffer.from(line, "utf8");
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`[RX hex  ]: ${hex}`);
  }
});

port.open((err) => {
  if (err) {
    console.error("Failed to open port:", err.message);
    process.exit(1);
  }

  console.log("Port opened.");
  console.log(`Sending version query: ${JSON.stringify(REQUEST + "\\r\\n")}`);

  const toSend = REQUEST + "\r\n";

  port.write(toSend, (writeErr) => {
    if (writeErr) {
      console.error("Write error:", writeErr.message);
      process.exit(1);
    }

    console.log("Query sent. Waiting up to 10 seconds for responses...\n");

    // After 10s, stop and close
    setTimeout(() => {
      console.log(`\nTimeout reached. Total bytes received: ${totalBytes}`);
      console.log("Closing port...");

      port.close((closeErr) => {
        if (closeErr) {
          console.error("Error closing port:", closeErr.message);
          process.exit(1);
        }
        console.log("Port closed. Exiting.");
        process.exit(0);
      });
    }, 10000);
  });
});