/** Tiny DOM builder. Text is always set as text nodes; no HTML strings reach the document. */
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

function append(el: Element, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}
function apply(el: Element, attrs: Attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key === 'className' ? 'class' : key, value === true ? '' : String(value));
  }
}
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); apply(el, attrs); append(el, kids); return el;
}
const SVG = 'http://www.w3.org/2000/svg';
export function s(tag: string, attrs: Attrs = {}, ...kids: Child[]): SVGElement {
  const el = document.createElementNS(SVG, tag); apply(el, attrs); append(el, kids); return el;
}
/** Reference to a symbol in the page's inline sprite. */
export function icon(name: string, cls = 'ic'): SVGElement {
  return s('svg', { class: cls, 'aria-hidden': 'true', focusable: 'false' }, s('use', { href: `#i-${name}` }));
}
export function clear(el: Element, ...kids: Child[]) { el.replaceChildren(); append(el, kids); }
