import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    /**
     * One fork for the whole suite, not one per file.
     *
     * vitest 4's forks pool can finish every test and then fail to end: a
     * worker that does not answer the stop message leaves its IPC channel
     * referenced, and the event loop stays alive with nothing left to do.
     * That is what the first run of this suite on CI did, passing all 54
     * files in ten seconds and then sitting there until it was cancelled six
     * minutes later.
     *
     * The threads pool is not the way out: `process.chdir` does not exist in
     * a worker thread, and one test needs it to prove that a `cordon.yaml`
     * lying in the working directory is ignored.
     *
     * The suite is not slower for this. Fifty-four files each paying for a
     * fork cost more than reusing one process: ten seconds became seven.
     */
    poolOptions: { forks: { singleFork: true } },
  },
})
