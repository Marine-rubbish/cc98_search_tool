import { parseSoakOptions, runSoak, soakHelp } from './soak.js';

async function main() {
  const options = parseSoakOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(soakHelp);
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runSoak(options, abort.signal, {
      onStarted: value => console.log(JSON.stringify({
        status: value.attached ? 'attached' : 'started',
        jobId: value.jobId,
        deadline: value.deadline,
        runDir: value.runDir,
        instruction: '按 Ctrl-C 停止；运行期间请保持 Chrome 和 CC98 标签页打开',
      })),
    });
    console.log(JSON.stringify({
      classification: result.kind,
      success: result.success,
      message: result.message,
      runDir: result.runDir,
      jobId: result.summary?.jobId,
    }, null, 2));
    if (result.kind === 'user_stopped') process.exitCode = 130;
    else if (result.kind === 'setup_failed') process.exitCode = 2;
    else if (!result.success) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 2;
});
