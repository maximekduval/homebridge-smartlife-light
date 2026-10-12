import { Broadcast, discover } from './tuya/discovery';

type Waiter = (found: Broadcast | undefined) => void;

/**
 * Finds the current IP address of lights. Requests made around the same time share one network scan, so ten lights
 * starting together cost one discovery, not ten.
 */
export class Locator {
    private waiting = new Map<string, Waiter[]>();
    private timer?: NodeJS.Timeout;
    private running = false;

    constructor(private readonly timeoutMs = 8000, private readonly debug: (message: string) => void = () => undefined) {}

    locate(id: string): Promise<Broadcast | undefined> {
        return new Promise((resolve) => {
            this.waiting.set(id, [...(this.waiting.get(id) ?? []), resolve]);
            this.schedule();
        });
    }

    private schedule() {
        if (this.running || this.timer) {
            return;
        }
        this.timer = setTimeout(() => void this.run(), 300);
    }

    private async run() {
        this.timer = undefined;
        this.running = true;
        const batch = this.waiting;
        this.waiting = new Map();
        let found = new Map<string, Broadcast>();
        try {
            found = await discover({ ids: batch.keys(), timeoutMs: this.timeoutMs, debug: this.debug });
        } catch (e) {
            this.debug(`discovery failed: ${(e as Error).message}`);
        }
        for (const [id, waiters] of batch) {
            for (const resolve of waiters) {
                resolve(found.get(id));
            }
        }
        this.running = false;
        if (this.waiting.size > 0) {
            this.schedule();
        }
    }
}
