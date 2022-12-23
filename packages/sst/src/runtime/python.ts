import path from "path";
import fs from "fs/promises";
import { useRuntimeHandlers } from "./handlers.js";
import { useRuntimeWorkers } from "./workers.js";
import { Context } from "../context/context.js";
import { VisibleError } from "../error.js";
import { ChildProcessWithoutNullStreams, exec, spawn } from "child_process";
import { promisify } from "util";
import { useRuntimeServerConfig } from "./server.js";
import { isChild } from "../util/fs.js";
import { Runtime } from "aws-cdk-lib/aws-lambda";
const execAsync = promisify(exec);
import os from "os";
import url from "url";

const RUNTIME_MAP: Record<string, Runtime> = {
  "python2.7": Runtime.PYTHON_2_7,
  "python3.6": Runtime.PYTHON_3_6,
  "python3.7": Runtime.PYTHON_3_7,
  "python3.8": Runtime.PYTHON_3_8,
  "python3.9": Runtime.PYTHON_3_9,
};

export const usePythonHandler = Context.memo(() => {
  const workers = useRuntimeWorkers();
  const handlers = useRuntimeHandlers();
  const server = useRuntimeServerConfig();
  const processes = new Map<string, ChildProcessWithoutNullStreams>();
  const sources = new Map<string, string>();

  handlers.register({
    shouldBuild: (input) => {
      const parent = sources.get(input.functionID);
      if (!parent) return false;
      return isChild(parent, input.file);
    },
    canHandle: (input) => input.startsWith("python"),
    startWorker: async (input) => {
      const src = "services";
      const parsed = path.parse(path.relative(src, input.handler));
      const target = [...parsed.dir.split(path.sep), parsed.name].join(".");
      const proc = spawn(
        os.platform() === "win32" ? "python.exe" : "python3.6".split(".")[0],
        [
          "-u",
          url.fileURLToPath(
            new URL("../support/python-runtime/runtime.py", import.meta.url)
          ),
          target,
          src,
          parsed.ext.substring(1),
        ],
        {
          env: {
            ...process.env,
            ...input.environment,
            IS_LOCAL: "true",
            AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "1024",
            AWS_LAMBDA_RUNTIME_API: `localhost:${server.port}/${input.workerID}`,
          },
          shell: true,
          cwd: path.join(process.cwd(), src),
        }
      );
      proc.on("exit", () => workers.exited(input.workerID));
      proc.stdout.on("data", (data: Buffer) => {
        workers.stdout(input.workerID, data.toString());
      });
      proc.stderr.on("data", (data: Buffer) => {
        workers.stdout(input.workerID, data.toString());
      });
      processes.set(input.workerID, proc);
    },
    stopWorker: async (workerID) => {
      const proc = processes.get(workerID);
      if (proc) {
        proc.kill();
        processes.delete(workerID);
      }
    },
    build: async (input) => {
      return {
        type: "success",
        handler: input.props.handler!,
      };
    },
  });
});

async function find(dir: string, target: string): Promise<string> {
  if (dir === "/") throw new VisibleError(`Could not find a ${target} file`);
  if (
    await fs
      .access(path.join(dir, target))
      .then(() => true)
      .catch(() => false)
  )
    return dir;
  return find(path.join(dir, ".."), target);
}