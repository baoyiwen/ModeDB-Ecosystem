// file: utils/readFiles.ts
import { promises as fs } from 'fs';
import * as path from 'path';

type ParsedData = unknown;

export interface ReadFileSuccess<T = ParsedData> {
  path: string;
  data: T;
  error?: undefined;
}

export interface ReadFileError {
  path: string;
  data?: undefined;
  error: Error;
}

export type ReadFileResult<T = ParsedData> =
  | ReadFileSuccess<T>
  | ReadFileError;

/**
 * 简单 CSV 解析
 */
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');

  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(
      headers.map((h, i) => [h.trim(), values[i]?.trim()])
    );
  });
}

/**
 * 按扩展名解析
 */
function parseByExt(filePath: string, content: string): ParsedData {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.json':
      return JSON.parse(content);
    case '.csv':
      return parseCSV(content);
    default:
      return content;
  }
}

/**
 * 批量读取文件
 */
export async function readFiles<T = ParsedData>(
  paths: string[]
): Promise<ReadFileResult<T>[]> {
  if (!Array.isArray(paths)) {
    throw new TypeError('paths must be an array');
  }

  const tasks = paths.map(async (p): Promise<ReadFileResult<T>> => {
    try {
      const content = await fs.readFile(p, 'utf-8');
      const data = parseByExt(p, content) as T;
      return { path: p, data };
    } catch (error) {
      return {
        path: p,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });

  return Promise.all(tasks);
}