const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backend = process.env.DX_LIGHT_NATIVE_BACKEND || "dxgi";
const samplerExe = backend === "gdi"
  ? path.join(root, "native", "bin", "DxLightBorderSampler.exe")
  : path.join(root, "native", "bin", "DxLightDxgiBorderSampler.exe");

const options = {
  displayId: process.env.DX_LIGHT_DISPLAY_ID || "DISPLAY1",
  x: Number(process.env.DX_LIGHT_DISPLAY_X || 0),
  y: Number(process.env.DX_LIGHT_DISPLAY_Y || 0),
  width: Number(process.env.DX_LIGHT_DISPLAY_WIDTH || 3413),
  height: Number(process.env.DX_LIGHT_DISPLAY_HEIGHT || 1440),
  samplingRate: Number(process.env.DX_LIGHT_SAMPLING_RATE || 80),
  edgeThicknessPx: Number(process.env.DX_LIGHT_EDGE_THICKNESS_PX || process.env.DX_LIGHT_SAMPLING_RATE || 80),
  edgeNumber: Number(process.env.DX_LIGHT_EDGE_NUMBER || 3),
  intervalMs: Number(process.env.DX_LIGHT_CAPTURE_INTERVAL || 50),
  frames: Number(process.env.DX_LIGHT_BENCH_FRAMES || 120),
  fastScale: process.env.DX_LIGHT_FAST_SCALE === "1",
  pointSample: process.env.DX_LIGHT_POINT_SAMPLE !== "0",
};

const args = [
  "--displayId", options.displayId,
  "--x", String(options.x),
  "--y", String(options.y),
  "--width", String(options.width),
  "--height", String(options.height),
  "--samplingRate", String(options.samplingRate),
  "--edgeThicknessPx", String(options.edgeThicknessPx),
  "--edgeNumber", String(options.edgeNumber),
  "--intervalMs", String(options.intervalMs),
  "--frames", String(options.frames),
];

if (options.fastScale) {
  args.push("--fastScale", "true");
}

if (!options.pointSample) {
  args.push("--pointSample", "false");
}

const child = spawn(samplerExe, args, {
  cwd: root,
  windowsHide: true,
});

const samples = [];
let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  let newline = stdout.indexOf("\n");
  while (newline >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.type === "frame") {
          samples.push(message.elapsedMs);
        }
      } catch {
        // Ignore non-json diagnostics.
      }
    }
    newline = stdout.indexOf("\n");
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("exit", (code) => {
  if (code !== 0) {
    console.error(stderr);
    process.exit(code || 1);
  }
  if (!samples.length) {
    console.error(stderr);
    console.error("No frame samples received.");
    process.exit(1);
  }

  samples.sort((left, right) => left - right);
  const sum = samples.reduce((total, value) => total + value, 0);
  const percentile = (value) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * value))];
  console.log(JSON.stringify({
    backend,
    display: options,
    frames: samples.length,
    captureMs: {
      min: round(samples[0]),
      avg: round(sum / samples.length),
      p50: round(percentile(0.5)),
      p95: round(percentile(0.95)),
      max: round(samples[samples.length - 1]),
    },
  }, null, 2));
});

function round(value) {
  return Math.round(value * 1000) / 1000;
}
