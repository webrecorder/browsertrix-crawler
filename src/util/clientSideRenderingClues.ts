export type CSRClue = {
  name: string;
  category: string;
  pattern: string;
  description: string;
};

/**
 * Various clues to identify client-side rendering (CSR) in source HTML.
 */
export const CSR_CLUES: CSRClue[] = [
  // Empty container divs
  {
    name: "empty_div",
    category: "empty_container",
    pattern:
      "<div\\s+id=[\"'](?:app|root|mount|application|main|__next|__nuxt|react-root|vue-app|gatsby-focus-wrapper)[\"']\\s*>\\s*</div>",
    description: "Empty container divs typical of SPA/CSR",
  },
  {
    name: "empty_div_self_closing",
    category: "empty_container",
    pattern:
      "<div\\s+id=[\"'](?:app|root|mount|application|main|__next|__nuxt|react-root|vue-app|gatsby-focus-wrapper)[\"']\\s*/>",
    description: "Empty container divs typical of SPA/CSR (self-closing)",
  },
  // Framework meta tags
  {
    name: "nextjs_generator",
    category: "framework_meta",
    pattern: "<meta\\s+name=[\"']generator[\"']\\s+content=[\"']Next\\.js[\"']",
    description: "Next.js generator meta tag",
  },
  {
    name: "nextjs_head_count",
    category: "framework_meta",
    pattern: "<meta\\s+name=[\"']next-head-count[\"']",
    description: "Next.js head count meta tag",
  },
  {
    name: "framework_meta",
    category: "framework_meta",
    pattern:
      "<meta\\s+name=[\"']framework[\"']\\s+content=[\"'](?:React|Vue\\.js|Angular)[\"']",
    description: "Framework meta tag",
  },
  {
    name: "app_name_meta",
    category: "framework_meta",
    pattern:
      "<meta\\s+name=[\"']application-name[\"']\\s+content=[\"'](?:Vue\\s+App|React\\s+App)[\"']",
    description: "Application name meta tag",
  },
  // Bundler scripts
  {
    name: "bundler_script",
    category: "bundler_scripts",
    pattern:
      "<script[^>]*src=[\"'][^\"']*(?:webpack|vite|parcel|rollup|esbuild)[^\"']*\\.js[\"']",
    description: "Bundler script",
  },
  {
    name: "bundled_script",
    category: "bundler_scripts",
    pattern:
      "<script[^>]*src=[\"'][^\"']*(?:bundle|chunk|vendor|runtime|main)[^\"']*\\.[a-f0-9]{8,}\\.js[\"']",
    description: "Bundled script with hash",
  },
  {
    name: "webpack_data_attr",
    category: "bundler_scripts",
    pattern: "<script[^>]*\\sdata-webpack=[\"'][^\"']*[\"']",
    description: "Webpack data attribute",
  },
  {
    name: "vite_data_attr",
    category: "bundler_scripts",
    pattern: "<script[^>]*\\sdata-vite-fid=[\"'][^\"']*[\"']",
    description: "Vite data attribute",
  },
  // Hydration data
  {
    name: "nextjs_hydration",
    category: "hydration_data",
    pattern: "<script[^>]*id=[\"']__NEXT_DATA__[\"']",
    description: "Next.js hydration data",
  },
  {
    name: "nuxt_hydration",
    category: "hydration_data",
    pattern: "<script[^>]*id=[\"']__NUXT(?:_DATA)?__[\"']",
    description: "Nuxt hydration data",
  },
  {
    name: "vue_hydration",
    category: "hydration_data",
    pattern: "<script[^>]*id=[\"']__VUE__[\"']",
    description: "Vue hydration data",
  },
  {
    name: "angular_hydration",
    category: "hydration_data",
    pattern: "<script[^>]*id=[\"']ng-state[\"']",
    description: "Angular hydration data",
  },
  {
    name: "svelte_hydration",
    category: "hydration_data",
    pattern: "data-sveltekit-hydrate",
    description: "Svelte hydration data",
  },
  // Noscript warnings
  {
    name: "noscript",
    category: "noscript_warning",
    pattern: "<noscript>",
    description: "Noscript warning requiring JavaScript",
  },
  {
    name: "react_noscript",
    category: "noscript_warning",
    pattern: "<noscript>You\\s+need\\s+to\\s+enable\\s+JavaScript",
    description: "React noscript warning",
  },
  // Modern script loading
  {
    name: "async_script",
    category: "modern_script_loading",
    pattern: "<script[^>]*\\sasync[^>]*>",
    description: "Async script loading",
  },
  {
    name: "defer_script",
    category: "modern_script_loading",
    pattern: "<script[^>]*\\sdefer[^>]*>",
    description: "Defer script loading",
  },
  {
    name: "module_script",
    category: "modern_script_loading",
    pattern: "<script[^>]*\\stype=[\"']module[\"'][^>]*>",
    description: "ES module script",
  },
  {
    name: "dynamic_import",
    category: "modern_script_loading",
    pattern: "import\\s*\\(",
    description: "Dynamic import()",
  },
  // Web components
  {
    name: "multi_part_element_name",
    category: "web_components",
    pattern: "<\\w+(?:-\\w+)+\\b",
    description:
      "Multi-part element name (custom elements must have a dash in the name)",
  },
  {
    name: "custom_elements_api",
    category: "web_components",
    pattern:
      "customElements\\.(?:define|get|getName|upgrade|initialize|whenDefined)",
    description:
      "Defining/registering a custom element using the Custom Elements API",
  },
  {
    name: "custom_element_registry",
    category: "web_components",
    pattern: "customElementRegistry",
    description: "Custom element registry",
  },
  // Direct DOM manipulation
  {
    name: "dom_manipulation",
    category: "dom_manipulation",
    pattern:
      "[\\w\\d_]+(?:[\"'`]?\\])?\\.(?:createElement|createElementNS|createTextNode|appendChild|append|appendNode|replaceChild|replaceChildren|replaceWith|insertBefore|insertAdjacentElement|insertAdjacentHTML|insertAdjacentText|removeChild|remove|moveBefore|innerHTML|innerText)",
    description: "Create/add/move/remove a node/element/text to/from the DOM",
  },
  {
    name: "output_element",
    category: "dom_manipulation",
    pattern: "<output[^>]*>",
    description:
      "Output element (often used for outputs of calculations or form results)",
  },
  {
    name: "template_element",
    category: "dom_manipulation",
    pattern: "<template[^>]*>",
    description:
      "Template element (used for defining reusable HTML structures that can be cloned and inserted into the DOM with JS)",
  },
  // Frames and embeds (e.g. iframes)
  {
    name: "iframe",
    category: "frames_and_embeds",
    pattern: "<iframe[^>]*>",
    description: "Iframe element",
  },
  {
    name: "object",
    category: "frames_and_embeds",
    pattern: "<object[^>]*>",
    description: "Object element",
  },
  {
    name: "embed",
    category: "frames_and_embeds",
    pattern: "<embed[^>]*>",
    description: "Embed element",
  },
];
