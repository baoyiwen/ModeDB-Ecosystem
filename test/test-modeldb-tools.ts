import { ModelDB } from '@mode-db/sdk';
import { DataType} from '@mode-db/common';

const modelDB = new ModelDB({
    host: '127.0.0.1',
    port: 9090,
    token: '60f7a1b89cf8175a7dfdb2f310658ebff53ce280c3d9bb9adc9b4d65dfef514d',
});

const client = await modelDB.use('test_db');

await client.quickLinkBatch([
    
])