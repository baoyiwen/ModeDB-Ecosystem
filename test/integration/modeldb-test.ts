import { ModelDB, RemoteModelDBClient } from "@mode-db/sdk";
import type {
    BatchRegisterInput,
    BatchRegisterResult,
    BindResult,
    InsertManyResult,
    RemoteHydratedEntity,
    WireRelationStats,
} from "@mode-db/sdk";
import {
    DataType,
} from '@mode-db/common';


export type ModelDBTestConfig = {
    host: string;
    port: number;
    token: string;
    database: string;
}

export class ModelDBTest {
    private config!: ModelDBTestConfig;
    public modelDB!: ModelDB;
    private remoteClient!: RemoteModelDBClient;
    constructor(props: ModelDBTestConfig) {
        this.config = props;
        this.init();
    }

    init() {
        this.modelDB = new ModelDB({
            host: this.config.host,
            port: this.config.port,
            token: this.config.token,
        });
        this.connectDB();
        // console.error('ModelDB initialized', this.modelDB);
    }

    async connectDB() {
        this.modelDB.getDatabaseCatalog('test_db').then((catalog) => {
            console.error('Database catalog', catalog);
        });

        // this.remoteClient = await connectRemote({
        //     url: `http://${this.config.host}:${this.config.port}`,
        //     token: this.config.token,
        //     dbName: this.config.database,
        // });

        this.remoteClient = new RemoteModelDBClient({
            url: `http://${this.config.host}:${this.config.port}`,
            // port: this.config.port,
            token: this.config.token,
            dbName: this.config.database,
        });

        console.error('Remote client: ', this.remoteClient);
    }

    async createModel() {
        await this.remoteClient.registerModel('test_model', {});
    }

    async test_create_model() {
       return this.remoteClient.alterModel('test_model', {
        id: DataType.String,
        name: DataType.String,
       });
    }

    async insertModel() {
        return this.remoteClient.model('test_model').insertMany([{
            id: '1',
            name: 'test',
        }]);
    }

    queryModel() {
        return this.remoteClient.model('test_model').query().execute();
    }

    getModel(name: string) {
        return this.remoteClient.model(name);
    }

    // -------------------------------------------------------------------------
    // Demo coverage for the new SDK surface. These are intentionally not
    // auto-invoked — call them selectively from the bottom of this file.
    // -------------------------------------------------------------------------

    /** Idempotent bulk DDL using compact tuples (equivalent to `AuthoringEngine.quickLink` per tuple). */
    async demo_quickLinkBatch(): Promise<BatchRegisterResult> {
        return this.remoteClient.quickLinkBatch([
            ['user', 'order', 'placed', 'placedBy'],
            ['order', 'item', 'contains', 'belongsTo'],
        ]);
    }

    /** Structured batch DDL: typed schemas + optional match predicates on relations. */
    async demo_batchRegister(): Promise<BatchRegisterResult> {
        const input: BatchRegisterInput = {
            models: [
                { name: 'user', schema: { id: DataType.String, email: DataType.String } },
                { name: 'order', schema: { id: DataType.String, userId: DataType.String } },
            ],
            relations: [
                {
                    source: 'user',
                    target: 'order',
                    forward: 'placed',
                    reverse: 'placedBy',
                    logic: 'one-to-many',
                    matchOn: { sourceField: 'id', targetField: 'userId' },
                },
            ],
            quickLink: true,
        };
        return this.remoteClient.batchRegister(input);
    }

    /** Single-row insert returning a live row handle with `_id` + `bind()` capability. */
    async demo_insertOne(modelName: string, data: Record<string, unknown>): Promise<RemoteHydratedEntity> {
        return this.remoteClient.model(modelName).insertOne(data);
    }

    /** `insertMany({ returning: true })` — the server echoes each row (with `_id`). */
    async demo_insertManyReturning(
        modelName: string,
        rows: readonly Record<string, unknown>[],
    ): Promise<InsertManyResult> {
        return this.remoteClient.model(modelName).insertMany(rows, { returning: true });
    }

    /** Bind two rows (order-of-arguments must match registration source → target). */
    async demo_bindPair(
        source: RemoteHydratedEntity,
        target: RemoteHydratedEntity,
        forward: string,
        reverse: string,
    ): Promise<BindResult> {
        return this.remoteClient.bindRelation(source, target, forward, reverse);
    }

    /**
     * Late-bind sample: models already exist with data, relation registered afterwards.
     * Uses PROTOCOL strategy + `matchOn` to backfill edges in bulk; returns the final stats.
     */
    async demo_lateBindProtocol(
        forward: string,
        matchOn: { sourceField: string; targetField: string },
    ): Promise<{ pairsCount: number; stats: WireRelationStats }> {
        const out = await this.remoteClient.bind(forward, 'PROTOCOL', { matchOn });
        if (!out.stats) {
            throw new Error('demo_lateBindProtocol: server did not return stats.');
        }
        return { pairsCount: out.pairsCount, stats: out.stats };
    }

    /** Dry-run count + 20-pair sample for any bind strategy (Designer preview). */
    async demo_previewBind(forward: string, matchOn: { sourceField: string; targetField: string }) {
        return this.remoteClient.previewBind(forward, 'PROTOCOL', { matchOn, sample: 20 });
    }

    /** Live edge counters for a relation (drives Designer edge annotations). */
    async demo_relationStats(forward: string): Promise<WireRelationStats> {
        const { forwardKeys, reverseKeys, totalLinks } =
            await this.remoteClient.relationStats(forward);
        return { forwardKeys, reverseKeys, totalLinks };
    }

    destroy() {
        this.remoteClient.close();
    }
}

const modelDBTest = new ModelDBTest({
    host: '127.0.0.1',
    port: 9090,
    token: '60f7a1b89cf8175a7dfdb2f310658ebff53ce280c3d9bb9adc9b4d65dfef514d',
    database: 'test_db',
});

console.error('Model: ', modelDBTest.getModel('test_model'));
// // modelDBTest.test_create_model().then((res) => {
// //     console.error('Res: ', res);
// //     // console.error('Model: ', modelDBTest.modelDB.getDatabaseCatalog('test_db').then(res => console.error('Model: ', res)));
// // });
// modelDBTest.insertModel().then((res) => {
//     console.error('Res: ', res);
//     modelDBTest.queryModel().then((res) => {
//         console.error('Res: ', res);
//     });
//     // console.error('Model: ', modelDBTest.modelDB.getDatabaseCatalog('test_db').then(res => console.error('Model: ', res)));
// });

// modelDBTest.createModel();
// modelDBTest.destroy();



// const engine = new AuthoringEngine({
//     atlas: 'test_db',
//     storageRoot: 'test_db',
//     connectToken: '60f7a1b89cf8175a7dfdb2f310658ebff53ce280c3d9bb9adc9b4d65dfef514d',
// });

// engine.registerModel('test_model', {
//     id: DataType.String,
//     name: DataType.String,
// });

// console.error('Engine: ', engine);