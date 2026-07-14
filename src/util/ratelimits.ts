import { KNOWN_RATE_LIMIT_WAF_SIGNATURES } from "./ratelimitrules";

// Rate Limit Constants
export const RATE_LIMIT_TTL_SECS = 300;

export const DEFAULT_RATE_LIMIT_STATUS_CODES = [429, 503];

// default text matches to consider rate limit
// export const DEFAULT_RATE_LIMIT_RULES = [
//   // Cloudflare Challenges
//   'challenges.cloudflare.com.*id="challenge-error-text":403',
//   // Incapsula with 200
//   'src="/_Incapsula_Resource?:200',
// ];

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
