/**
 * Cache implementations for Gitiles data
 */

import { createLogger, type Logger } from '@chromium-search/shared';

// ============================================================================
// Cache Interface
// ============================================================================

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// In-Memory Cache
// ============================================================================

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

export class InMemoryCache implements Cache {
  private store = new Map<string, CacheItem<unknown>>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get<T>(key: string): Promise<T | null> {
    const item = this.store.get(key) as CacheItem<T> | undefined;
    
    if (!item) {
      return null;
    }

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictOldest();
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  private evictOldest(): void {
    // Remove expired entries first
    const now = Date.now();
    for (const [key, item] of this.store) {
      if (item.expiresAt < now) {
        this.store.delete(key);
      }
    }

    // If still over capacity, remove oldest 10%
    if (this.store.size >= this.maxSize) {
      const toRemove = Math.ceil(this.maxSize * 0.1);
      let removed = 0;
      for (const key of this.store.keys()) {
        if (removed >= toRemove) break;
        this.store.delete(key);
        removed++;
      }
    }
  }

  // For testing
  size(): number {
    return this.store.size;
  }
}

// ============================================================================
// Redis Cache (Placeholder for production)
// ============================================================================

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  flushDb(): Promise<void>;
}

export class RedisCache implements Cache {
  private client: RedisClientLike;
  private prefix: string;
  private logger: Logger;

  constructor(client: RedisClientLike, prefix = 'chromium-search:') {
    this.client = client;
    this.prefix = prefix;
    this.logger = createLogger('RedisCache');
  }

  private prefixKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(this.prefixKey(key));
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (error) {
      this.logger.warn({ key, error: String(error) }, 'Redis get error');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.setEx(
        this.prefixKey(key),
        ttlSeconds,
        JSON.stringify(value)
      );
    } catch (error) {
      this.logger.warn({ key, error: String(error) }, 'Redis set error');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.prefixKey(key));
    } catch (error) {
      this.logger.warn({ key, error: String(error) }, 'Redis delete error');
    }
  }

  async clear(): Promise<void> {
    try {
      await this.client.flushDb();
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'Redis clear error');
    }
  }
}

// ============================================================================
// Cache Manager
// ============================================================================

export class CacheManager {
  private static instance: CacheManager;
  private cache: Cache;

  private constructor() {
    // Default to in-memory cache
    this.cache = new InMemoryCache();
  }

  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  setCache(cache: Cache): void {
    this.cache = cache;
  }

  getCache(): Cache {
    return this.cache;
  }
}
