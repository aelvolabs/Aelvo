/**
 * Runtime metrics and health, ported from runtime_next/monitoring.
 * Series are bounded in memory; no specialist or fabricated activity metrics.
 */

export interface MetricPoint {
  value: number;
  tags: Record<string, string>;
  at: number;
}

function seriesKey(name: string, tags: Record<string, string>): string {
  const tagString = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return tagString.length === 0 ? name : `${name}[${tagString}]`;
}

export class MetricSeries {
  readonly name: string;
  private readonly points: MetricPoint[] = [];
  private readonly maxPoints: number;

  constructor(name: string, maxPoints = 1_000) {
    this.name = name;
    this.maxPoints = maxPoints;
  }

  record(value: number, tags: Record<string, string> = {}): void {
    this.points.push({ value, tags, at: Date.now() });
    if (this.points.length > this.maxPoints) this.points.shift();
  }

  get count(): number {
    return this.points.length;
  }

  get latest(): number | null {
    return this.points.at(-1)?.value ?? null;
  }

  avg(): number | null {
    if (this.points.length === 0) return null;
    return this.points.reduce((sum, point) => sum + point.value, 0) / this.points.length;
  }

  min(): number | null {
    if (this.points.length === 0) return null;
    return Math.min(...this.points.map((point) => point.value));
  }

  max(): number | null {
    if (this.points.length === 0) return null;
    return Math.max(...this.points.map((point) => point.value));
  }

  percentile(pct: number): number | null {
    if (this.points.length === 0) return null;
    const sorted = this.points.map((point) => point.value).sort((a, b) => a - b);
    const rank = Math.ceil((Math.max(0, Math.min(100, pct)) / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)] ?? null;
  }

  stats(): Record<string, number | null> {
    return {
      count: this.count,
      latest: this.latest,
      avg: this.avg(),
      min: this.min(),
      max: this.max(),
      p95: this.percentile(95),
    };
  }
}

export class RuntimeMetrics {
  private readonly series = new Map<string, MetricSeries>();
  private readonly maxPoints: number;

  constructor(maxPoints = 2_000) {
    this.maxPoints = maxPoints;
  }

  record(name: string, value = 1, tags: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(name, tags);
    let target = this.series.get(key);
    if (target === undefined) {
      target = new MetricSeries(key, this.maxPoints);
      this.series.set(key, target);
    }
    target.record(value, tags);
  }

  get(name: string, tags: Record<string, string> = {}): MetricSeries | undefined {
    return this.series.get(seriesKey(name, tags));
  }

  summary(): Record<string, Record<string, number | null>> {
    return Object.fromEntries(
      [...this.series.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, series]) => [key, series.stats()]),
    );
  }
}

export interface HealthCheck {
  name: string;
  check: () => { healthy: boolean; detail?: string };
}

export interface HealthResult {
  name: string;
  healthy: boolean;
  detail: string;
}

/** On-demand health checks; no background timer and no invented liveness. */
export class HealthMonitor {
  private checks: HealthCheck[] = [];

  register(name: string, check: () => { healthy: boolean; detail?: string }): void {
    this.checks = this.checks.filter((item) => item.name !== name);
    this.checks.push({ name, check });
  }

  run(): HealthResult[] {
    return this.checks.map((item) => {
      try {
        const result = item.check();
        return { name: item.name, healthy: result.healthy, detail: result.detail ?? "" };
      } catch (error) {
        return {
          name: item.name,
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  status(): "healthy" | "degraded" | "unhealthy" {
    const results = this.run();
    if (results.length === 0) return "degraded";
    if (results.every((result) => result.healthy)) return "healthy";
    if (results.some((result) => result.healthy)) return "degraded";
    return "unhealthy";
  }
}
