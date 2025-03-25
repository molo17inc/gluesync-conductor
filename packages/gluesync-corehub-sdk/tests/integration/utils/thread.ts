/**
 * Simple Thread implementation for Node.js to mimic Python's threading module.
 * Used in integration tests to run background tasks.
 */

export class Thread {
  private task: () => void;
  private thread: NodeJS.Timeout | null = null;
  
  /**
   * Creates a new Thread instance.
   * @param task The function to run in the thread
   */
  constructor(task: () => void) {
    this.task = task;
  }
  
  /**
   * Starts the thread.
   */
  start(): void {
    // Use setImmediate to run the task in the next event loop iteration
    this.thread = setImmediate(() => {
      this.task();
    });
  }
  
  /**
   * Joins the thread (not actually implemented, just a placeholder for API compatibility).
   * @param timeout Optional timeout in milliseconds
   */
  join(timeout?: number): void {
    // This is a no-op in Node.js since we're using the event loop
    // Just here for API compatibility with the Python version
    if (timeout) {
      setTimeout(() => {
        // Do nothing, just wait for the timeout
      }, timeout);
    }
  }
}
