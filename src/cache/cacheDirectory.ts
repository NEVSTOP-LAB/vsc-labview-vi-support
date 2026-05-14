import * as fs from 'fs';
import * as path from 'path';

export function getCacheRoot(storageRoot: string): string {
  return path.join(storageRoot, 'vi-cache');
}

export function shouldSyncCacheDirectory(current: string | undefined, next: string): boolean {
  return (current ?? '') !== next;
}

export async function ensureCacheRoot(cacheRoot: string): Promise<void> {
  await fs.promises.mkdir(cacheRoot, { recursive: true });
}

export async function clearCacheRoot(cacheRoot: string): Promise<void> {
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  await ensureCacheRoot(cacheRoot);
}