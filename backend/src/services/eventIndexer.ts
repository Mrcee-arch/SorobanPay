import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import prisma from '../lib/prisma';
import { AuditLogger } from './auditLogger';

const auditLogger = new AuditLogger();

// ─── Type definitions ──────────────────────────────────────────────────────

export enum ContractEventType {
  SUBSCRIBE = 'subscribe',
  EXECUTED = 'executed',
}

interface ParsedEvent {
  type: ContractEventType;
  subscriber: string;
  merchant: string;
  token: string;
  amount: string;
  ledger: number;
  eventId: string;
  timestamp: Date;
}

interface IndexingState {
  lastProcessedLedger: number;
  eventsProcessed: number;
  failedEvents: number;
}

// ─── Configuration constants ───────────────────────────────────────────────

const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const INDEXING_STATE_KEY = 'sorobanpay:indexing:state';

export class EventIndexer {
  private rpcUrl: string;
  private contractId: string;
  private server: SorobanRpc.Server;
  private processingState: IndexingState;

  constructor(rpcUrl: string, contractId: string) {
    this.rpcUrl = rpcUrl;
    this.contractId = contractId;
    this.server = new SorobanRpc.Server(rpcUrl);
    this.processingState = {
      lastProcessedLedger: 0,
      eventsProcessed: 0,
      failedEvents: 0,
    };
  }

  /**
   * Initialize the indexer and load persisted state
   */
  async initialize(): Promise<void> {
    try {
      const savedState = localStorage?.getItem(INDEXING_STATE_KEY);
      if (savedState) {
        this.processingState = JSON.parse(savedState);
        console.log(
          `[EventIndexer] Resumed from ledger ${this.processingState.lastProcessedLedger}`
        );
      }
    } catch (error) {
      console.warn('[EventIndexer] Failed to load persisted state:', error);
      this.processingState = {
        lastProcessedLedger: 0,
        eventsProcessed: 0,
        failedEvents: 0,
      };
    }
  }

  /**
   * Persist the current indexing state
   */
  private persistState(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          INDEXING_STATE_KEY,
          JSON.stringify(this.processingState)
        );
      }
    } catch (error) {
      console.warn('[EventIndexer] Failed to persist state:', error);
    }
  }

  /**
   * Fetch and store events, with retry logic and state tracking
   */
  async fetchAndStoreEvents(startLedger?: number): Promise<void> {
    const ledger = startLedger || this.processingState.lastProcessedLedger || 1;

    console.log(
      `[EventIndexer] Fetching events from ledger ${ledger} for contract ${this.contractId}`
    );

    try {
      const eventsResponse = await this.server.getEvents({
        startLedger: ledger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: BATCH_SIZE,
      });

      if (!eventsResponse.events || eventsResponse.events.length === 0) {
        console.log('[EventIndexer] No new events found');
        return;
      }

      console.log(
        `[EventIndexer] Found ${eventsResponse.events.length} events to process`
      );

      const results = {
        successful: 0,
        failed: 0,
        skipped: 0,
      };

      // Process each event with individual retry logic
      for (const event of eventsResponse.events) {
        try {
          const retryCount = await this.processEventWithRetry(event);
          if (retryCount < 0) {
            results.failed++;
            this.processingState.failedEvents++;
          } else if (retryCount === 0) {
            results.successful++;
            this.processingState.eventsProcessed++;
          } else {
            results.skipped++;
          }

          // Update state after each event
          this.processingState.lastProcessedLedger = event.ledger;
        } catch (error) {
          console.error(
            `[EventIndexer] Unrecoverable error processing event ${event.id}:`,
            error
          );
          results.failed++;
          this.processingState.failedEvents++;
        }
      }

      this.persistState();

      console.log(
        `[EventIndexer] Processing complete - Successful: ${results.successful}, Failed: ${results.failed}, Skipped: ${results.skipped}`
      );
      console.log(
        `[EventIndexer] Total indexed: ${this.processingState.eventsProcessed}, Last ledger: ${this.processingState.lastProcessedLedger}`
      );
    } catch (error) {
      console.error('[EventIndexer] Error fetching events from RPC:', error);
      throw error;
    }
  }

  /**
   * Process a single event with retry logic
   * Returns: -1 if failed, 0 if successful, 1 if skipped (duplicate)
   */
  private async processEventWithRetry(
    event: SorobanRpc.RawEvent
  ): Promise<number> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await this.processEvent(event);
        return result ? 0 : 1; // 0 = success, 1 = skipped
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `[EventIndexer] Attempt ${attempt + 1}/${MAX_RETRIES} failed for event ${event.id}:`,
          lastError.message
        );

        if (attempt < MAX_RETRIES - 1) {
          await this.delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    console.error(
      `[EventIndexer] Event ${event.id} failed after ${MAX_RETRIES} attempts:`,
      lastError
    );
    return -1;
  }

  /**
   * Process a single event and store if valid
   * Returns: true if stored, false if skipped
   */
  private async processEvent(event: SorobanRpc.RawEvent): Promise<boolean> {
    try {
      const parsedEvent = this.parseEvent(event);

      // Validate event type
      if (!Object.values(ContractEventType).includes(parsedEvent.type as any)) {
        console.log(
          `[EventIndexer] Skipping unknown event type: ${parsedEvent.type}`
        );
        return false;
      }

      // Check for duplicates
      const existingEvent = await prisma.event.findFirst({
        where: {
          type: parsedEvent.type,
          subscriber: parsedEvent.subscriber,
          merchant: parsedEvent.merchant,
          token: parsedEvent.token,
          amount: parsedEvent.amount,
          ledgerTimestamp: BigInt(parsedEvent.ledger),
        },
      });

      if (existingEvent) {
        console.log(
          `[EventIndexer] Skipping duplicate event: ${parsedEvent.type} (${parsedEvent.eventId})`
        );
        return false;
      }

      // Store the event
      await prisma.event.create({
        data: {
          type: parsedEvent.type,
          subscriber: parsedEvent.subscriber,
          merchant: parsedEvent.merchant,
          token: parsedEvent.token,
          amount: parsedEvent.amount,
          ledgerTimestamp: BigInt(parsedEvent.ledger),
        },
      });

      console.log(
        `[EventIndexer] Stored ${parsedEvent.type} event: subscriber=${parsedEvent.subscriber.slice(0, 6)}..., amount=${parsedEvent.amount}`
      );

      // Persist audit log for payment execution events
      if (parsedEvent.type === ContractEventType.EXECUTED) {
        await auditLogger.logPayment({
          eventType: parsedEvent.type,
          subscriber: parsedEvent.subscriber,
          merchant: parsedEvent.merchant,
          token: parsedEvent.token,
          amount: parsedEvent.amount,
          transactionHash: parsedEvent.eventId,
          ledger: BigInt(parsedEvent.ledger),
        });
      }

      return true;
    } catch (error) {
      console.error('[EventIndexer] Error processing individual event:', error);
      throw error;
    }
  }

  /**
   * Parse a Soroban event and extract relevant data
   */
  private parseEvent(event: SorobanRpc.RawEvent): ParsedEvent {
    const topics = event.topic;

    if (!topics || topics.length < 4) {
      throw new Error(
        `Invalid event structure: expected at least 4 topics, got ${topics?.length || 0}`
      );
    }

    // Extract event type from first topic
    const eventTypeSymbol = xdr.ScVal.fromXDR(topics[0], 'base64');
    const eventType = eventTypeSymbol.sym().toString();

    // Extract subscriber address from second topic
    const subscriberScVal = xdr.ScVal.fromXDR(topics[1], 'base64');
    const subscriber = subscriberScVal.address().toString();

    // Extract merchant address from third topic
    const merchantScVal = xdr.ScVal.fromXDR(topics[2], 'base64');
    const merchant = merchantScVal.address().toString();

    // Extract token address from fourth topic
    const tokenScVal = xdr.ScVal.fromXDR(topics[3], 'base64');
    const token = tokenScVal.address().toString();

    // Extract amount from event value
    const amountScVal = xdr.ScVal.fromXDR(event.value, 'base64');
    let amount: string;
    try {
      amount = amountScVal.i128().toString();
    } catch (e) {
      // If it's not i128, try u64
      try {
        amount = amountScVal.u64().toString();
      } catch (u64Error) {
        throw new Error(
          `Failed to parse amount as i128 or u64: ${u64Error}`
        );
      }
    }

    return {
      type: eventType as ContractEventType,
      subscriber,
      merchant,
      token,
      amount,
      ledger: event.ledger,
      eventId: event.id,
      timestamp: new Date(),
    };
  }

  /**
   * Query indexed events for a specific merchant
   */
  async getEventsForMerchant(merchantAddress: string): Promise<any[]> {
    try {
      const events = await prisma.event.findMany({
        where: {
          merchant: merchantAddress,
        },
        orderBy: {
          ledgerTimestamp: 'desc',
        },
      });

      return events;
    } catch (error) {
      console.error(
        '[EventIndexer] Error querying events for merchant:',
        error
      );
      throw error;
    }
  }

  /**
   * Query indexed events for a specific subscriber
   */
  async getEventsForSubscriber(subscriberAddress: string): Promise<any[]> {
    try {
      const events = await prisma.event.findMany({
        where: {
          subscriber: subscriberAddress,
        },
        orderBy: {
          ledgerTimestamp: 'desc',
        },
      });

      return events;
    } catch (error) {
      console.error(
        '[EventIndexer] Error querying events for subscriber:',
        error
      );
      throw error;
    }
  }

  /**
   * Get current indexing state
   */
  getState(): IndexingState {
    return { ...this.processingState };
  }

  /**
   * Utility: delay for a specified number of milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
