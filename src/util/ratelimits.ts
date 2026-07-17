//import { KNOWN_RATE_LIMIT_WAF_SIGNATURES } from "./ratelimitrules.js";

const KNOWN_RATE_LIMIT_WAF_SIGNATURES = [
  // CF
  {
    regex: /challenges.cloudflare.com.*id="challenge-error-text"/i,
    statuses: [403],
  },

  // Incapsula
  { regex: /'src="\/_Incapsula_Resource[?]/i, statuses: [200] },

  // Other
  {
    regex: /Sorry, we need to verify that this request is legitimate/,
    statuses: [403],
  },
  {
    regex: /Your connection needs to be verified before you can proceed/,
    statuses: [403],
  },
  { regex: /\(robot\)/, statuses: [403] },
];

// Rate Limit Constants
export const RATE_LIMIT_TTL_SECS = 300;

export const DEFAULT_RATE_LIMIT_STATUS_CODES = [429, 503];

const rateLimitMap = new Map<number, RegExp[]>();

export function isRateLimitTextMatched(
  text: string,
  status: number,
): string | null {
  const matches = rateLimitMap.get(status);
  const allStatusMatches = rateLimitMap.get(0);

  if (matches) {
    for (const match of matches) {
      if (match.exec(text)) {
        return match.toString();
      }
    }
  }

  if (allStatusMatches) {
    for (const match of allStatusMatches) {
      if (match.exec(text)) {
        return match.toString();
      }
    }
  }

  return null;
}

export function initRateLimitMatchRules(additionalRules: string[]) {
  const getMatches = (status: number) => {
    let matches = rateLimitMap.get(status);
    if (!matches) {
      matches = [];
      rateLimitMap.set(status, matches);
    }
    return matches;
  };

  // default rules
  for (const { regex, statuses } of KNOWN_RATE_LIMIT_WAF_SIGNATURES) {
    for (const status of statuses) {
      getMatches(status).push(regex);
    }
  }

  for (const rule of additionalRules) {
    // match any status by default
    let status = 0;
    let regex = "";
    if (rule.match(/:[\d]+$/)) {
      const parts = rule.split(":");
      regex = parts[0];
      status = parseInt(parts[1]) ?? 0;
    } else {
      regex = rule;
    }

    getMatches(status).push(new RegExp(regex));
  }
}
