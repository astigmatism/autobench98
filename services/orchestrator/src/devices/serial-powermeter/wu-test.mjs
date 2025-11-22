// wu-test.mjs
// Minimal "Watts Up? PRO" probe that mirrors wattsup.py's command sequence,
// and decodes watts / volts / amps from "#d,..." frames.
//
// Sequence (from wattsup.py + protocol docs):
//   1) Open serial at 115200 baud
//   2) Send "#V,3;"          -> version / capability query
//   3) Send "#L,W,3,E,,1;"   -> set INTERNAL mode, 1 second interval
//   4) Send "#O,W,1,3;"      -> full handling options
//   5) Read ASCII lines starting with "#d" (and others) until user exits
//   6) On Ctrl-C, send "#L,W,0;" -> stop logging, then close port.
//
// Notes on "#d" frame layout (based on wattsup.py + observed data):
//   Example: "#d,-,18,124,1191,97,0,_,_,_,124,_,_,_,_,_,100,_,_,_,_;"
//
//   index : meaning (best-known info)
//     0   : "#d"          -> data prefix
//     1   : "-"           -> unknown / placeholder
//     2   : "18"          -> line count / sample index (per docs)
//     3   : "124"         -> watts_raw   (W = raw / 10    => 12.4 W)
//     4   : "1191"        -> volts_raw   (V = raw / 10    => 119.1 V)
//     5   : "97"          -> amps_raw    (A = raw / 1000  => 0.097 A)
//     6   : "0"           -> likely Wh or cumulative energy (spec TBD)
//   7..9  : "_"           -> reserved/unused in this mode
//    10   : "124"         -> another W-ish value (avg/peak? TBD)
// 11..15  : "_"           -> more reserved/unused in this mode
//    16   : "100"         -> likely Power Factor * 100 (1.00 => 100)
// 17..20  : "_" / ""      -> trailing fields, reserved / not used here
//
// For now we *only* treat W/V/A as first-class signals, but the above
// indices are here as a starting point for future exploration.

import { SerialPort } from "serialport";

const PORT_PATH = "/dev/cu.usbserial-A7005IDU";
const BAUD_RATE = 115200;

// Match wattsup.py defaults:
const INTERNAL_MODE = "E";  // INTERNAL_MODE
const FULLHANDLING = 3;     // FULLHANDLING
const INTERVAL_SEC = 1;     // interval in seconds

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeCommand(port, cmd) {
  return new Promise((resolve, reject) => {
    const wire = cmd + "\r\n"; // WattsUp uses CRLF
    console.log(`>> ${JSON.stringify(wire)} (cmd: ${cmd})`);
    port.write(wire, (err) => {
      if (err) {
        console.error("Write error:", err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

console.log(`Opening port: ${PORT_PATH} @ ${BAUD_RATE} baud`);

const port = new SerialPort({
  path: PORT_PATH,
  baudRate: BAUD_RATE,
  autoOpen: false,
});

let buffer = "";
let totalBytes = 0;
let stopSent = false;

port.on("error", (err) => {
  console.error("Port error:", err.message);
});

port.on("data", (data) => {
  totalBytes += data.length;
  const chunk = data.toString("ascii");
  buffer += chunk;

  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#d")) {
      handleDataFrame(trimmed);
    } else if (trimmed.startsWith("#")) {
      console.log(`[CTRL] ${JSON.stringify(trimmed)}`);
    } else {
      console.log(`[LINE] ${JSON.stringify(trimmed)}`);
    }
  }
});

/**
 * Parse and print a "#d,..." data frame with labeled/scaled W/V/A,
 * using human-readable names.
 */
function handleDataFrame(line) {
  // console.log(`[DATA] raw frame: ${JSON.stringify(line)}`);

  const fields = line.split(",");
  if (fields.length < 6) {
    console.warn("[DATA] frame too short to parse W/V/A");
    return;
  }

  const wattsRaw = Number(fields[3]);
  const voltsRaw = Number(fields[4]);
  const ampsRaw = Number(fields[5]);

  if (Number.isNaN(wattsRaw) || Number.isNaN(voltsRaw) || Number.isNaN(ampsRaw)) {
    console.warn("[DATA] could not parse numeric W/V/A:", {
      wattsRaw: fields[3],
      voltsRaw: fields[4],
      ampsRaw: fields[5],
    });
    return;
  }

  const watts = wattsRaw / 10;
  const volts = voltsRaw / 10;
  const amps = ampsRaw / 1000;

  // Additional exploratory fields
  const whRaw = fields[6];
  const wattsAltRaw = fields[10];
  const pfRaw = fields[16];

  const ts = new Date().toISOString();

  console.log(
    `[READING ${ts}]  Watts: ${watts.toFixed(3)} W   |   Volts: ${volts.toFixed(
      2
    )} V   |   Amps: ${amps.toFixed(4)} A`
  );

  /*
  console.log(
    `            (wattHoursRaw=${JSON.stringify(
      whRaw
    )}, wattsAltRaw=${JSON.stringify(wattsAltRaw)}, powerFactorRaw=${JSON.stringify(
      pfRaw
    )})`
  );
  */
}

port.open(async (err) => {
  if (err) {
    console.error("Failed to open port:", err.message);
    process.exit(1);
  }

  console.log("Port opened.");

  try {
    console.log("\n--- Step 1: version query (#V,3;) ---");
    await writeCommand(port, "#V,3;");
    await sleep(500);

    console.log("\n--- Step 2: set INTERNAL mode / interval ---");
    const modeCmd = `#L,W,3,${INTERNAL_MODE},,${INTERVAL_SEC};`;
    await writeCommand(port, modeCmd);
    await sleep(500);

    console.log("\n--- Step 3: set output handling (#O,W,1,3;) ---");
    const outCmd = `#O,W,1,${FULLHANDLING};`;
    await writeCommand(port, outCmd);

    console.log(
      "\nCommands sent. Streaming data until you press Ctrl+C…" +
        "\n   Look for lines like: 'Watts: 12.400 W | Volts: 119.20 V | Amps: 0.0970 A'\n"
    );
  } catch (e) {
    console.error("Error during setup:", e);
    port.close(() => process.exit(1));
  }
});

// ------------------------------ Shutdown ------------------------------

async function shutdown() {
  if (stopSent === false && port.isOpen) {
    stopSent = true;
    console.log('\n--- Shutdown: stop logging (#L,W,0;) ---');
    await writeCommand(port, "#L,W,0;");
    await sleep(200);
  }

  console.log(`\nTotal bytes received: ${totalBytes}`);
  console.log("Closing port…");

  port.close((err) => {
    if (err) {
      console.error("Close error:", err.message);
    }
    console.log("Port closed. Exiting.");
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  shutdown().catch((err) => {
    console.error("Shutdown error:", err);
    process.exit(1);
  });
});