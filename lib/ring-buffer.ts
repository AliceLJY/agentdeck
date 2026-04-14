import { RING_BUFFER_SIZE } from './types';

/**
 * Circular buffer for storing recent terminal output.
 * When a session is detached, PTY output is written here
 * so it can be replayed when a client reattaches.
 *
 * Default capacity: 256KB (configurable).
 */
export class RingBuffer {
  private buffer: string[];
  private totalLength: number;
  private capacity: number;

  constructor(capacity: number = RING_BUFFER_SIZE) {
    this.buffer = [];
    this.totalLength = 0;
    this.capacity = capacity;
  }

  /**
   * Append data to the buffer. If total stored data exceeds capacity,
   * older chunks are dropped from the front.
   */
  write(data: string): void {
    this.buffer.push(data);
    this.totalLength += data.length;

    // Evict oldest chunks until we're within capacity
    while (this.totalLength > this.capacity && this.buffer.length > 1) {
      const removed = this.buffer.shift()!;
      this.totalLength -= removed.length;
    }

    // If a single chunk exceeds capacity, truncate it from the front
    if (this.totalLength > this.capacity && this.buffer.length === 1) {
      const chunk = this.buffer[0];
      this.buffer[0] = chunk.slice(chunk.length - this.capacity);
      this.totalLength = this.buffer[0].length;
    }
  }

  /**
   * Read all buffered data in order (oldest to newest).
   */
  read(): string {
    return this.buffer.join('');
  }

  /**
   * Clear all buffered data.
   */
  clear(): void {
    this.buffer = [];
    this.totalLength = 0;
  }

  /**
   * Current amount of data stored (in characters).
   */
  get size(): number {
    return this.totalLength;
  }
}
