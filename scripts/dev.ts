import { networkInterfaces } from "node:os";

const FRONTEND_PORT = 3000;
const SIGNALING_PORT = 3001;

type DevProcess = {
  label: string;
  process: Bun.Subprocess<"pipe", "pipe", "inherit">;
};

function localAddresses(): string[] {
  const addresses = new Set<string>(["localhost"]);

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const details of interfaces ?? []) {
      if (details.family === "IPv4" && !details.internal) {
        addresses.add(details.address);
      }
    }
  }

  return [...addresses];
}

function printDevUrls(): void {
  console.log("");
  console.log("P2P Metronome dev URLs");
  console.log("");

  for (const address of localAddresses()) {
    console.log(`  Host:      http://${address}:${FRONTEND_PORT}/host/`);
    console.log(`  Frontend:  http://${address}:${FRONTEND_PORT}/`);
    console.log(`  Signaling: ws://${address}:${SIGNALING_PORT}/ws/host`);
    console.log("");
  }

  console.log("  Client URLs are shown in the host page after creating a room.");
  console.log("");
}

async function pipeWithPrefix(stream: ReadableStream<Uint8Array> | null, label: string, output: (text: string) => void): Promise<void> {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      output(`[${label}] ${line}\n`);
    }
  }

  buffered += decoder.decode();
  if (buffered) {
    output(`[${label}] ${buffered}\n`);
  }
}

function startProcess(label: string, cwd: string): DevProcess {
  return {
    label,
    process: Bun.spawn(["bun", "run", "dev"], {
      cwd,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    }),
  };
}

function killProcesses(processes: DevProcess[]): void {
  for (const child of processes) {
    if (child.process.exitCode === null) {
      child.process.kill();
    }
  }
}

async function main(): Promise<void> {
  printDevUrls();

  if (process.argv.includes("--info")) {
    return;
  }

  const processes = [
    startProcess("frontend", "frontend"),
    startProcess("server", "server"),
  ];

  let shuttingDown = false;

  for (const child of processes) {
    void pipeWithPrefix(child.process.stdout, child.label, (text) => process.stdout.write(text));
    void pipeWithPrefix(child.process.stderr, child.label, (text) => process.stderr.write(text));
  }

  const shutdown = () => {
    shuttingDown = true;
    killProcesses(processes);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const firstExit = await Promise.race(
    processes.map(async (child) => ({
      label: child.label,
      exitCode: await child.process.exited,
    })),
  );

  killProcesses(processes);

  if (shuttingDown) {
    process.exit(130);
  }

  if (firstExit.exitCode !== 0) {
    console.error(`[dev] ${firstExit.label} exited with code ${firstExit.exitCode}`);
    process.exit(firstExit.exitCode);
  }
}

void main();
