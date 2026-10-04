/*---
description: Stop a start.py actuator early. Cancel the process, read its state, and run finally.py in the clone unless the state is exited with code 0. Returns the state, the exit code, and safe.
uses: [cancel, wait, bash]
args:
  type: object
  properties:
    handle:
      type: string
      description: The handle of the actuator process.
    clone:
      type: string
      description: The path of the clone of the psu fork, such as ~/bench-psu.
  required: [handle, clone]
  additionalProperties: false
---*/
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
// A call rejects when the process ends with a code other than 0. The error holds the result.
const settled = (call) =>
	call.catch((error) => {
		if (!error.details) throw error;
		return error.details;
	});
await settled(tools.cancel({ handle: args.handle }));
const waited = await settled(tools.wait({ handles: [args.handle], timeout: 0 }));
const process = waited.process ?? waited.processes[0];
const safe = process.state === 'exited' && process.exitCode === 0;
const result = { state: process.state, exitCode: process.exitCode ?? null, safe };
if (safe) return result;
const path = args.clone.startsWith('~/')
	? `"$HOME"/${quote(args.clone.slice(2))}`
	: quote(args.clone);
const run = await tools
	.bash({ command: `cd ${path} && python3 finally.py`, wait: 30 })
	.catch((error) => error.details ?? { text: String(error.message), process: {} });
result.finally = run.text;
result.finallyExitCode = run.process?.exitCode ?? null;
return result;
