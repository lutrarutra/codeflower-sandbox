---
name: codeflower-batch-jobs
description: Submit and follow batch jobs on the cluster with codeflower-job, each of which runs in a sandbox like this one. Use when a computation is bigger or longer than this sandbox's allocation, when there are many independent pieces (samples, chromosomes, parameter sets), when the user asks to run something as a job, or before writing any job script. Only applies when codeflower-doctor says batch jobs are on.
---

# Batch jobs

`codeflower-doctor` (section "Batch jobs") says whether the app submits jobs for this sandbox, and
with which scheduler, queues, defaults and limits; `codeflower-job info` says the same. When jobs are
off, work within this sandbox's allocation and tell the user that jobs would need their config.

## What a job is

`codeflower-job submit` asks the code flower app, outside this sandbox, to submit a command. The job
runs on a node the scheduler picks, **in a sandbox like this one**: the same image, the same `/data`
folders, the workspace and the project's software environments, at the same paths, and the same
network (isolated if this one is). There is no agent in it, and no scheduler command (`sbatch`,
`qsub`) in this sandbox: always go through `codeflower-job`.

So a job script uses the paths and software you use here. Prepare everything first:

- **Install software here** before submitting: jobs see the project's environments (venv, conda,
  R library) read-only by default, and cannot install into them.
- **Write the script into the workspace or an output folder**, and make it executable, or run an
  interpreter on it (`-- python /data/code/x/step.py`).
- **Write results into an output folder or the workspace**, one file (or folder) per task, so tasks
  running at once do not overwrite each other.
- **Try it here on a small piece first** (one sample, a few minutes), so a mistake does not fail a
  hundred tasks.

## Submitting

```sh
codeflower-job submit --name align --cpus 8 --memory 32G --time 4h -- ./scripts/align.sh sample1
codeflower-job submit --name per-sample --array 1-48%8 --cpus 4 --memory 16G --time 2h -- python scripts/one.py
codeflower-job submit --name merge --after j-3f2a1c -- python scripts/merge.py
```

- Ask for what the job needs, not the maximum: smaller requests start sooner. Use the queues the
  doctor lists, and the user's notes there.
- **Arrays** run the same command once per index, each with its index in `$CODEFLOWER_JOB_INDEX`
  (e.g. line N of a sample sheet). `%N` limits how many run at once; arrays have a size limit.
- **`--after ID[,ID]`** starts a job once those ended well, e.g. a merge after an array.
- `--workdir` is the folder the command runs in (default: the current one); `--env NAME=VALUE`
  sets variables.
- **The user may be asked to allow each job.** Before submitting, say in a sentence what you
  submit and why, and how many tasks. Never submit large arrays or many jobs without agreement.
  If the answer is pending, end your turn: you get a message when it is submitted or denied.

## Following them

- `codeflower-job list` lists this project's jobs; `status ID` shows one; IDs are `j-…` or the
  scheduler's.
- **You get a message when a job you submitted ends**: end your turn rather than polling.
  `codeflower-job wait ID` is only for jobs of a few minutes.
- `codeflower-job log ID` prints its output (`--index N` for an array task, `--tail 50`, `--follow`);
  `--scheduler` prints the scheduler's own log, for a job that failed before its command ran
  (e.g. out of memory or time, or the image not reachable on that node).
- When a job fails, read its log before resubmitting, and fix the cause; do not resubmit the same
  thing unchanged. A job that is `lost` was stopped from outside (time or memory limit, or
  cancelled): ask for more, or split the work.
- `codeflower-job cancel ID` cancels one of this project's jobs.
- Jobs keep running when this sandbox stops (unless the doctor says otherwise). Before you finish,
  or when told to wrap up, tell the user which jobs are still queued or running and where their
  output goes, and write that into your notes in the workspace.
