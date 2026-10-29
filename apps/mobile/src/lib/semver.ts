/** Minimal semver compare for `min_app_version` gating (major.minor.patch; a prerelease sorts before its release). */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** True when `appVersion` satisfies every `required` minimum. Unparseable minimums are treated as 0.0.0. */
export function satisfiesMinVersion(appVersion: string, ...required: (string | null | undefined)[]): boolean {
  return required.every((r) => !r || compareSemver(appVersion, r) >= 0);
}

function parse(v: string): { nums: [number, number, number]; pre: string | null } {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return { nums: [0, 0, 0], pre: null };
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? null };
}
