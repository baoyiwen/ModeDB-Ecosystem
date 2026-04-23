import { ModelDB, RemoteHydratedEntity } from '@mode-db/sdk';
import { DataType} from '@mode-db/common';
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

// <----------------------------------------------------------------------- 文件读取 ↑ --------------------------------------------------------------------------------------->

const modelDB = new ModelDB({
    host: '127.0.0.1',
    port: 9090,
    token: '60f7a1b89cf8175a7dfdb2f310658ebff53ce280c3d9bb9adc9b4d65dfef514d',
});

const client = await modelDB.use('test_db');
// client.dropModel('administrative_division').then(res => {
//     console.error('Res', res)
// })
await client.quickLinkBatch([
  ['administrative_division', 'administrative_division', 'children', 'parent'],
]);
await client.alterModel('administrative_division', {
  code: DataType.String,
  name: DataType.String,
});

// const administrativeDivision = client.model('administrative_division');
// console.error(administrativeDivision);
// const [province, cities] = await readFiles([
//   './datas/provinces.csv',
//   './datas/cities.csv',
// ]);
// const provinceData = province.data as Record<string, string>[];
// const citiesData   = cities.data   as Record<string, string>[];

// console.error(citiesData);
// console.error(provinceData);
// provinceData.forEach(async p => {
//     const pRow = await client.model('administrative_division').insertOne({
//         code: p.code,
//         name: p.name,
//     });
//     citiesData.forEach(async c => {
//         if (c.provinceCode === p.code) {
//             const cRow = await client.model('administrative_division').insertOne({
//                 code: c.code,
//                 name: c.name,
//             });
//             await client.bindRelation(pRow, cRow, 'children', 'parent');
//         }
//     })
// })
// const provinceByCode = new Map<string, unknown>();
// for (const p of provinceData) {
//   const row = await client.model('administrative_division').insertOne({
//     code: p.code,
//     name: p.name,
//   });
//   provinceByCode.set(p.code, row);
// }
// for (const c of citiesData) {
//   const cRow = await client.model('administrative_division').insertOne({
//     code: c.code,
//     name: c.name,
//   });
//   const pRow = provinceByCode.get(c.provinceCode) as RemoteHydratedEntity;
//   if (pRow) {
//     await client.bindRelation(pRow , cRow , 'children', 'parent');
//   }
// }
const res = await client
  .model('administrative_division')
  .query()
  // .relate('children')
  .execute();
console.log('Res:', res);




