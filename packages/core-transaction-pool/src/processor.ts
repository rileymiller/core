import { Repositories } from "@arkecosystem/core-database";
import { Container, Contracts, Providers, Utils } from "@arkecosystem/core-kernel";
import { Errors, Handlers } from "@arkecosystem/core-transactions";
import { Crypto, Enums, Errors as CryptoErrors, Interfaces, Managers, Transactions } from "@arkecosystem/crypto";

import { dynamicFeeMatcher } from "./dynamic-fee";
import { DynamicFeeMatch, TransactionsCached, TransactionsProcessed } from "./interfaces";

/**
 * @todo: this class has too many responsibilities at the moment.
 * Its sole responsibility should be to validate transactions and return them.
 */
@Container.injectable()
export class Processor implements Contracts.TransactionPool.Processor {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.TransactionRepository)
    private readonly transactionRepository!: Repositories.TransactionRepository;

    @Container.inject(Container.Identifiers.TransactionPoolWalletRepository)
    private readonly poolWalletRepository!: Contracts.State.WalletRepository;

    private transactions: Interfaces.ITransactionData[] = [];
    private readonly excess: string[] = [];
    private readonly accept: Map<string, Interfaces.ITransaction> = new Map();
    private readonly broadcast: Map<string, Interfaces.ITransaction> = new Map();
    private readonly invalid: Map<string, Interfaces.ITransactionData> = new Map();
    private readonly errors: { [key: string]: Contracts.TransactionPool.TransactionErrorResponse[] } = {};

    private pool!: Contracts.TransactionPool.Connection;

    public initialize(pool: Contracts.TransactionPool.Connection) {
        this.pool = pool;

        return this;
    }

    public async validate(
        transactions: Interfaces.ITransactionData[],
    ): Promise<Contracts.TransactionPool.ProcessorResult> {
        this.cacheTransactions(transactions);

        if (this.transactions.length > 0) {
            await this.filterAndTransformTransactions(this.transactions);

            await this.removeForgedTransactions();

            await this.addTransactionsToPool();

            this.printStats();
        }

        return {
            accept: Array.from(this.accept.keys()),
            broadcast: Array.from(this.broadcast.keys()),
            invalid: Array.from(this.invalid.keys()),
            excess: this.excess,
            errors: Object.keys(this.errors).length > 0 ? this.errors : undefined,
        };
    }

    public getTransactions(): Interfaces.ITransactionData[] {
        return this.transactions;
    }

    public getBroadcastTransactions(): Interfaces.ITransaction[] {
        return Array.from(this.broadcast.values());
    }

    public getErrors(): { [key: string]: Contracts.TransactionPool.TransactionErrorResponse[] } {
        return this.errors;
    }

    public pushError(transaction: Interfaces.ITransactionData, type: string, message: string): void {
        Utils.assert.defined<string>(transaction.id);

        const id: string = transaction.id;

        if (!this.errors[id]) {
            this.errors[id] = [];
        }

        this.errors[id].push({ type, message });

        this.invalid.set(id, transaction);
    }

    private cacheTransactions(transactions: Interfaces.ITransactionData[]): void {
        const { added, notAdded }: TransactionsCached = this.app
            .get<Contracts.State.StateStore>(Container.Identifiers.StateStore)
            .cacheTransactions(transactions);

        this.transactions = added;

        for (const transaction of notAdded) {
            Utils.assert.defined<string>(transaction.id);

            if (!this.errors[transaction.id]) {
                this.pushError(transaction, "ERR_DUPLICATE", "Already in cache.");
            }
        }
    }

    private async removeForgedTransactions(): Promise<void> {
        const forgedIdsSet: string[] = await this.transactionRepository.getForgedTransactionsIds([
            ...new Set([...this.accept.keys(), ...this.broadcast.keys()]),
        ]);

        for (const id of forgedIdsSet) {
            const transaction: Interfaces.ITransaction | undefined = this.accept.get(id);

            Utils.assert.defined<Interfaces.ITransaction>(transaction);

            this.pushError(transaction.data, "ERR_FORGED", "Already forged.");

            this.accept.delete(id);
            this.broadcast.delete(id);
        }
    }

    private async filterAndTransformTransactions(transactions: Interfaces.ITransactionData[]): Promise<void> {
        const maxTransactionBytes: number | undefined = this.app
            .get<Providers.ServiceProviderRepository>(Container.Identifiers.ServiceProviderRepository)
            .get("@arkecosystem/core-transaction-pool")
            .config()
            .get<number>("maxTransactionBytes");

        Utils.assert.defined<number>(maxTransactionBytes);

        for (const transaction of transactions) {
            Utils.assert.defined<string>(transaction.id);
            Utils.assert.defined<string>(transaction.senderPublicKey);

            const id: string = transaction.id;
            const exists: boolean = await this.pool.has(id);

            if (exists) {
                this.pushError(transaction, "ERR_DUPLICATE", `Duplicate transaction ${id}`);
            } else if (JSON.stringify(transaction).length > maxTransactionBytes) {
                this.pushError(
                    transaction,
                    "ERR_TOO_LARGE",
                    `Transaction ${id} is larger than ${maxTransactionBytes} bytes.`,
                );
            } else if (await this.pool.hasExceededMaxTransactions(transaction.senderPublicKey)) {
                this.excess.push(id);
            } else if (await this.validateTransaction(transaction)) {
                try {
                    const receivedId: string = id;
                    const transactionInstance: Interfaces.ITransaction = Transactions.TransactionFactory.fromData(
                        transaction,
                    );

                    Utils.assert.defined<string>(transactionInstance.data.id);

                    const handler: Handlers.TransactionHandler = await this.app
                        .get<Handlers.Registry>(Container.Identifiers.TransactionHandlerRegistry)
                        .get(transactionInstance.data);

                    if (await handler.verify(transactionInstance, this.poolWalletRepository)) {
                        try {
                            const dynamicFee: DynamicFeeMatch = await dynamicFeeMatcher(this.app, transactionInstance);
                            if (!dynamicFee.enterPool && !dynamicFee.broadcast) {
                                this.pushError(
                                    transaction,
                                    "ERR_LOW_FEE",
                                    "The fee is too low to broadcast and accept the transaction",
                                );
                            } else {
                                if (dynamicFee.enterPool) {
                                    this.accept.set(transactionInstance.data.id, transactionInstance);
                                }

                                if (dynamicFee.broadcast) {
                                    this.broadcast.set(transactionInstance.data.id, transactionInstance);
                                }
                            }
                        } catch (error) {
                            this.pushError(transaction, "ERR_APPLY", error.message);
                        }
                    } else {
                        transaction.id = receivedId;

                        this.pushError(
                            transaction,
                            "ERR_BAD_DATA",
                            "Transaction didn't pass the verification process.",
                        );
                    }
                } catch (error) {
                    if (error instanceof CryptoErrors.TransactionSchemaError) {
                        this.pushError(transaction, "ERR_TRANSACTION_SCHEMA", error.message);
                    } else {
                        this.pushError(transaction, "ERR_UNKNOWN", error.message);
                    }
                }
            }
        }
    }

    private async validateTransaction(transaction: Interfaces.ITransactionData): Promise<boolean> {
        const now: number = Crypto.Slots.getTime();

        if (transaction.timestamp > now + 3600) {
            const secondsInFuture: number = transaction.timestamp - now;

            this.pushError(
                transaction,
                "ERR_FROM_FUTURE",
                `Transaction ${transaction.id} is ${secondsInFuture} seconds in the future`,
            );

            return false;
        }

        const lastHeight: number = this.app.get<any>(Container.Identifiers.StateStore).getLastHeight();

        const maxTransactionAge: number | undefined = this.app
            .get<Providers.ServiceProviderRepository>(Container.Identifiers.ServiceProviderRepository)
            .get("@arkecosystem/core-transaction-pool")
            .config()
            .get<number>("maxTransactionAge");

        Utils.assert.defined<number>(maxTransactionAge);

        const expirationContext = {
            blockTime: Managers.configManager.getMilestone(lastHeight).blocktime,
            currentHeight: lastHeight,
            now: Crypto.Slots.getTime(),
            maxTransactionAge,
        };

        const expiration: number | undefined = Utils.expirationCalculator.calculateTransactionExpiration(
            transaction,
            expirationContext,
        );

        if (expiration !== undefined && expiration <= lastHeight + 1) {
            this.pushError(
                transaction,
                "ERR_EXPIRED",
                `Transaction ${transaction.id} is expired since ${lastHeight - expiration} blocks.`,
            );

            return false;
        }

        if (transaction.network && transaction.network !== Managers.configManager.get("network.pubKeyHash")) {
            this.pushError(
                transaction,
                "ERR_WRONG_NETWORK",
                `Transaction network '${transaction.network}' does not match '${Managers.configManager.get(
                    "pubKeyHash",
                )}'`,
            );

            return false;
        }

        try {
            // @TODO: this leaks private members, refactor this
            const handler: Handlers.TransactionHandler = await this.app
                .get<Handlers.Registry>(Container.Identifiers.TransactionHandlerRegistry)
                .get(transaction);
            return handler.canEnterTransactionPool(transaction, this.pool, this);
        } catch (error) {
            if (error instanceof Errors.InvalidTransactionTypeError) {
                this.pushError(
                    transaction,
                    "ERR_UNSUPPORTED",
                    `Invalidating transaction of unsupported type '${Enums.TransactionType[transaction.type]}'`,
                );
            } else {
                this.pushError(transaction, "ERR_UNKNOWN", error.message);
            }
        }

        return false;
    }

    private async addTransactionsToPool(): Promise<void> {
        const { notAdded }: TransactionsProcessed = await this.pool.addTransactions(Array.from(this.accept.values()));

        for (const item of notAdded) {
            Utils.assert.defined<Interfaces.ITransaction>(item.transaction);

            const transaction: Interfaces.ITransaction = item.transaction;

            Utils.assert.defined<string>(transaction.id);

            const id: string = transaction.id;

            this.accept.delete(id);

            if (item.type !== "ERR_POOL_FULL") {
                this.broadcast.delete(id);
            }

            Utils.assert.defined<string>(item.type);
            Utils.assert.defined<string>(item.message);

            this.pushError(transaction.data, item.type, item.message);
        }
    }

    private printStats(): void {
        const stats: string = ["accept", "broadcast", "excess", "invalid"]
            .map(prop => `${prop}: ${this[prop] instanceof Array ? this[prop].length : this[prop].size}`)
            .join(" ");

        if (Object.keys(this.errors).length > 0) {
            this.app.log.debug(JSON.stringify(this.errors));
        }

        this.app.log.info(`Received ${Utils.pluralize("transaction", this.transactions.length, true)} (${stats}).`);
    }
}
