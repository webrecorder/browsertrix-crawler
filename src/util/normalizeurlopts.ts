import { Options as NormalizeUrlOptions } from "normalize-url";

// URL normalization options for consistent URL handling across the crawler
// Query parameters are sorted alphabetically by the normalize-url library
export const normalizeUrlOpts: NormalizeUrlOptions = {
  defaultProtocol: "https",
  stripAuthentication: false,
  stripTextFragment: false,
  stripWWW: false,
  stripHash: false,
  removeTrailingSlash: false,
  removeSingleSlash: false,
  removeExplicitPort: false,
  sortQueryParameters: true,
  removePath: false,
};
