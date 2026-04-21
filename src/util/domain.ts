import { getDomain } from "tldts-icann";

export function getRegistrableDomain(url: string): string | null {
  const domain = getDomain(url);
  return domain ? domain.toLowerCase() : null;
}
