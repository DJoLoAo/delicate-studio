import DATA from './countries.js'
import FLAGS from './flags-meta.js'

const CONTINENT_REGION = { EU: '150', AS: '142', AF: '002', NA: '003', SA: '005', OC: '009', AN: 'AQ' }
const LANG_HOME = {
  en: 'GB', de: 'DE', fr: 'FR', es: 'ES', pt: 'PT', it: 'IT', nl: 'NL', ar: 'SA', zh: 'CN', ru: 'RU', sv: 'SE', da: 'DK',
  no: 'NO', nb: 'NO', nn: 'NO', el: 'GR', sl: 'SI', cs: 'CZ', et: 'EE', ga: 'IE', ja: 'JP', ko: 'KR', hi: 'IN', ms: 'MY',
  sq: 'AL', sr: 'RS', uk: 'UA', fa: 'IR', he: 'IL', vi: 'VN', ka: 'GE', hy: 'AM', kk: 'KZ', sw: 'TZ', bn: 'BD', ur: 'PK',
  tr: 'TR', pl: 'PL', hu: 'HU', fi: 'FI', ro: 'RO', bg: 'BG', hr: 'HR', sk: 'SK', lt: 'LT', lv: 'LV', mt: 'MT', is: 'IS',
  th: 'TH', id: 'ID', tl: 'PH', ta: 'LK', ne: 'NP', km: 'KH', lo: 'LA', my: 'MM', mn: 'MN', am: 'ET', so: 'SO'
}
const GLOBE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='3 3 18 18' fill='none' stroke='white' stroke-opacity='.62' stroke-width='.85'%3E%3Ccircle cx='12' cy='12' r='8.5'/%3E%3Cpath d='M3 12h18M12 3c2.6 2.8 3.9 5.8 3.9 9s-1.3 6.2-3.9 9c-2.6-2.8-3.9-5.8-3.9-9S9.4 5.8 12 3z'/%3E%3Cpath d='M4.7 7.9c4.5 1.3 10.1 1.3 14.6 0M4.7 16.1c4.5-1.3 10.1-1.3 14.6 0' stroke-opacity='.4'/%3E%3C/svg%3E\")"

const V = (name, fallback) => `var(--lp-${name},${fallback})`
const ACCENT = V('accent', '#DF39BB')
const INK = V('ink', '#f6f1ff')
const MUTED = V('muted', '#9d98b8')
const FAINT = V('faint', '#6b6788')
const LINE = V('line', '#2a2d46')
const PANEL = V('panel', '#161829')
const EASE = V('ease', 'cubic-bezier(.2,.7,.1,1)')

const CSS = `
.lp{position:relative;display:inline-block;color:${INK};font:inherit;font-family:${V('font', 'inherit')};line-height:1.4}
.lp *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.lp-btn{display:flex;align-items:center;gap:8px;margin:0;background:transparent;border:1px solid ${LINE};color:inherit;font:inherit;font-size:12px;letter-spacing:.14em;padding:5px 12px 5px 6px;padding-inline:6px 12px;border-radius:999px;cursor:pointer;transition:border-color .35s ${EASE},background .35s ${EASE}}
.lp-btn:hover,.lp-btn[aria-expanded="true"]{border-color:${ACCENT};background:color-mix(in srgb,${ACCENT} 8%,transparent)}
.lp-btn:focus-visible{outline:2px solid ${ACCENT};outline-offset:3px}
.lp-btn .lp-flag{width:20px;height:20px}
.lp-btn-c:empty{display:none}
.lp-chev{width:14px;height:14px;flex:none;color:${MUTED};transition:transform .4s ${EASE}}
.lp-btn[aria-expanded="true"] .lp-chev{transform:rotate(180deg)}
.lp-flag{position:relative;isolation:isolate;display:block;flex:none;width:22px;height:22px;border-radius:50%;overflow:hidden;background-image:var(--lp-sprite);background-size:var(--lp-bgsize);background-repeat:no-repeat;box-shadow:0 0 0 1px rgba(255,255,255,.14);transition:box-shadow .25s,transform .35s ${EASE}}
.lp-flag::after{content:"";position:absolute;inset:0;border-radius:50%;z-index:1;background:${V('tint', '#9a6bff')};mix-blend-mode:multiply;opacity:${V('tint-strength', '.45')};transition:opacity .4s ${EASE}}
.lp-flag::before{content:"";position:absolute;inset:0;border-radius:50%;z-index:2;pointer-events:none;background:${GLOBE} center/100% 100% no-repeat,radial-gradient(circle at 30% 26%,rgba(255,255,255,.4),rgba(255,255,255,0) 44%),radial-gradient(circle at 72% 78%,rgba(13,14,24,.5),rgba(13,14,24,0) 62%)}
.lp-noglobe .lp-flag::before{display:none}
.lp-pop{position:absolute;top:calc(100% + 10px);inset-inline-end:0;z-index:1000;display:flex;width:min(860px,calc(100vw - 32px));height:min(480px,calc(100vh - 110px));background:${PANEL};border:1px solid ${LINE};border-radius:${V('radius', '18px')};box-shadow:0 30px 70px -24px rgba(0,0,0,.75);overflow:hidden;animation:lp-in .3s ${EASE}}
.lp[data-align="start"] .lp-pop{inset-inline-end:auto;inset-inline-start:0}
.lp-pop[hidden]{display:none}
.lp-inline{display:block}
.lp-inline .lp-btn{display:none}
.lp-inline .lp-pop{position:relative;top:auto;inset-inline-end:auto;z-index:auto;width:100%;height:var(--lp-height,480px);box-shadow:none;animation:none}
.lp-single .lp-tabs{display:none}
@keyframes lp-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
.lp-mapbox{position:relative;flex:1 1 auto;min-width:0;display:flex;flex-direction:column;border-inline-end:1px solid ${LINE};background:${V('sea', 'radial-gradient(circle at 46% 38%,#1b1d36,#111220 72%)')}}
.lp-tabs{display:flex;flex-wrap:wrap;gap:6px;flex:none;padding:12px 12px 4px}
.lp-tab{flex:none;margin:0;background:rgba(13,14,24,.5);border:1px solid ${LINE};color:${MUTED};font:inherit;font-size:12px;line-height:1.2;padding:6px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:color .25s,border-color .25s,background .25s}
.lp-tab:hover{color:${INK};border-color:color-mix(in srgb,${ACCENT} 45%,${LINE})}
.lp-tab[aria-pressed="true"]{color:${INK};border-color:${ACCENT};background:color-mix(in srgb,${ACCENT} 16%,transparent)}
.lp-tab:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
.lp-map{position:relative;flex:1 1 auto;min-height:0}
.lp-map svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:manipulation}
.lp-land{fill:${V('land', '#1d1f33')}}
.lp-c{fill:${V('country', '#2d2858')};stroke:${V('border', '#111220')};stroke-width:.6;vector-effect:non-scaling-stroke;cursor:pointer;outline:none;transition:fill .25s,opacity .25s}
circle.lp-c{fill:${V('dot', '#6c56c4')};stroke:transparent;vector-effect:none}
.lp-c.hot{fill:${V('hot', '#7a3a9e')}}
circle.lp-c.hot{fill:${V('hot-dot', '#b47cff')}}
.lp-c.sel,circle.lp-c.sel{fill:${ACCENT}}
.lp-filtering .lp-c:not(.match):not(.sel){opacity:.28}
.lp-cap{position:absolute;inset-inline-start:14px;bottom:14px;display:flex;align-items:center;gap:10px;max-width:calc(100% - 28px);padding:5px;padding-inline-end:14px;border-radius:999px;background:rgba(13,14,24,.8);border:1px solid ${LINE};font-size:13px;pointer-events:none}
.lp-cap-t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-cap-x{color:${MUTED}}
.lp-cap-x:empty{display:none}
.lp-side{flex:0 0 300px;display:flex;flex-direction:column;min-height:0;min-width:0}
.lp-search{display:flex;align-items:center;gap:8px;flex:none;margin:12px 12px 6px;padding:0 12px;border:1px solid ${LINE};border-radius:999px;transition:border-color .3s}
.lp-search:focus-within{border-color:${ACCENT}}
.lp-search svg{width:15px;height:15px;flex:none;color:${MUTED}}
.lp-search input{flex:1;min-width:0;margin:0;background:transparent;border:0;outline:0;color:inherit;font:inherit;font-size:14px;padding:8px 0;-webkit-appearance:none;appearance:none}
.lp-search input::placeholder{color:${FAINT}}
.lp-search input::-webkit-search-cancel-button{display:none}
.lp-list{position:relative;flex:1 1 auto;min-height:0;overflow:auto;padding:0 6px 8px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:${LINE} transparent}
.lp-h{position:sticky;top:0;z-index:1;padding:10px 12px 6px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${MUTED};background:${PANEL}}
.lp-o{display:flex;align-items:center;gap:12px;padding:7px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:${MUTED};outline:none;transition:background .2s,color .2s;content-visibility:auto;contain-intrinsic-size:auto var(--lp-row2,46px)}
.lp-o.lp-o1{contain-intrinsic-size:auto var(--lp-row1,36px)}
.lp-probe{position:absolute;visibility:hidden;inset-inline:6px;top:0;pointer-events:none}
.lp-probe .lp-o{content-visibility:visible}
.lp-o:hover,.lp-o:focus,.lp-o.hot{background:color-mix(in srgb,${ACCENT} 13%,transparent);color:${INK}}
.lp-o[aria-selected="true"]{color:${ACCENT}}
.lp-o[aria-selected="true"] .lp-flag{box-shadow:0 0 0 2px ${ACCENT}}
.lp-o:hover .lp-flag,.lp-o:focus .lp-flag{transform:scale(1.08)}
.lp-o:hover .lp-flag::after,.lp-o:focus .lp-flag::after,.lp-o.hot .lp-flag::after,.lp-o[aria-selected="true"] .lp-flag::after{opacity:.18}
.lp-o-t{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}
.lp-o-n,.lp-o-x{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-o-x{font-size:11.5px;color:${FAINT}}
.lp-o-c{flex:none;font-size:10.5px;letter-spacing:.16em;color:${FAINT}}
.lp-o[aria-selected="true"] .lp-o-c{color:${ACCENT}}
.lp-empty{padding:18px 16px;color:${MUTED};font-size:13px}
.lp-foot{display:flex;justify-content:flex-end;flex:none;padding:7px 14px 8px;border-top:1px solid ${LINE}}
.lp-credit{display:inline-flex;align-items:center;gap:7px;color:${FAINT};font-size:11px;letter-spacing:.06em;text-decoration:none;white-space:nowrap;transition:color .25s}
.lp-credit:hover,.lp-credit:focus-visible{color:${INK}}
.lp-credit:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px;border-radius:4px}
.lp-brand{width:87.5px;height:20px;flex:none;display:block}
.lp-o[hidden],.lp-g[hidden],.lp-empty[hidden]{display:none}
:root[lang="ar"] .lp-h,.lp[dir="rtl"] .lp-h{letter-spacing:0}
@media (max-width:640px){
.lp-pop{position:fixed;top:var(--lp-top,64px);left:10px;right:10px;width:auto;height:calc(100vh - var(--lp-top,64px) - 10px);height:calc(100dvh - var(--lp-top,64px) - 10px);max-height:640px;flex-direction:column}
.lp-mapbox{flex:none;height:min(36vh,250px);border-inline-end:0;border-bottom:1px solid ${LINE}}
.lp-side{flex:1 1 auto}
.lp-cap{bottom:8px;inset-inline-start:8px;font-size:12px}
.lp-inline .lp-pop{position:relative;top:auto;left:auto;right:auto;width:100%;height:var(--lp-height-phone,600px);max-height:none}
.lp-tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:10px 10px 2px;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent)}
.lp-tabs::-webkit-scrollbar{display:none}
.lp[dir="rtl"] .lp-tabs,[dir="rtl"] .lp-tabs{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 28px),transparent)}
}
@media (prefers-reduced-motion:reduce){.lp *,.lp *::before,.lp *::after{animation:none!important;transition:none!important}}
`

const SVG_NS = 'http://www.w3.org/2000/svg'
const CREDIT_HREF = 'https://delicateapps.com'
const CREDIT_TEXT = '© 2026 Delicate Audio'
const VERSION = '0.3.3'
const SIGNATURE = 'WorldPicker 0.3.3 · © 2026 Delicate Audio · delicateapps.com/worldpicker'
const BRAND_ICON = '<svg class="lp-brand" aria-hidden="true" viewBox="0 0 140 32"><path fill="#DF39BB" fill-rule="evenodd" d="M41.26.22l5.45.01c1.36.03 2.59.36 3.68.98l.55.38 .4.34 .57.63 .39.58 .27.51 .27.71 .15.58 .11.72 .05.71-.01.69-.1.87-.1.44-.26.78-.28.6-.29.48-.42.56-.35.37-.33.27-.7.5-.93.45-.53.19-.57.15-.92.16-.76.05h-5.34v-12.71zm53.31 1.36l-.51.04-.7.14-.41.11-.6.24-.29.15c-1.9 1.23-2.56 3.23-1.97 6c.29.92.68 1.6 1.19 2.04l.54.42c.88.57 1.84.86 2.88.89l1.44-.02 1.19-.14 .9-.18 .87-.27v1.49c-.29.16-1.14.36-2.52.58c-1.7.07-2.84.04-3.44-.11c-1.83-.26-3.29-1.29-4.38-3.1c-.4-.68-.63-1.69-.71-3.03c-.07-1.18.18-2.34.73-3.48c.29-.68.91-1.39 1.86-2.12c.95-.65 2.04-1.04 3.26-1.17c1.47-.18 3.09.02 4.85.6l.07.04v1.54c-.34-.1-.7-.21-1.08-.33c-1.01-.23-2.06-.33-3.17-.33zm-47.95.16l-3.55-.02v9.71l3.89-.01 .67-.09 .69-.18c1.25-.46 2.08-1.18 2.49-2.16c.64-1.85.65-3.43.04-4.73c-.66-1.35-1.69-2.15-3.08-2.4l-.65-.1-.5-.02zm61.37.24l-.04-.06-3.12 6.38h6.24l-3.08-6.32zm-49.19 3.68h7.17l.01 1.47-7.18.01v4.32h8.32l.01 1.47h-10.13v-12.71h10.03v1.48h-8.22l-.01 3.96zm81.09-5.44v1.48h-8.23v3.96h7.17v1.47l-7.17.01v4.32h8.33l-.01 1.47h-10.14l.01-12.7 10.04-.01zm-28.15 9.59l-7.57-.02-1.55 3.14h-1.97l6.29-12.71h2.08l6.3 12.71h-2.02l-1.56-3.12zm-39.16 1.62v.03h7.15v1.47h-8.94v-12.71h1.79v11.21zm10.2-11.21h1.8l-.01 12.71h-1.79v-12.71zm37.22 1.48h-5.09v-1.48h12v1.48h-5.09v11.23h-1.82v-11.23zm-88.56 15.09l-.57-.39-.88-.49-.97-.46-1.11-.35-1.36-.21c-.31-2.47-1.12-4.47-2.45-6c-1.54-1.79-3.31-2.96-5.3-3.53c-1.21-.31-2.22-.46-3.02-.45c-1.28.04-2.4.21-3.37.52c-2.14.72-3.87 1.91-5.18 3.58c-1.3 1.64-2.08 3.51-2.34 5.61c-.25 1.98.07 3.97.96 5.95c.91 1.86 2.12 3.32 3.64 4.36c1.69 1.18 3.58 1.83 5.66 1.96c.21 1.04.46 1.86.76 2.45c.38.91.85 1.7 1.42 2.36c-.09.04-.55.07-1.39.1c-1.51-.03-2.86-.18-4.03-.46c-1.86-.55-3.42-1.22-4.67-2.03c-1.44-1-2.65-2.07-3.62-3.21c-.88-1.12-1.61-2.28-2.2-3.49c-.68-1.63-1.13-3.21-1.35-4.74c-.13-1.26-.11-2.7.05-4.31c.29-1.53.62-2.74.99-3.64c.49-1.2 1.28-2.55 2.36-4.03c.8-.98 1.82-1.95 3.04-2.9c.93-.67 2.23-1.36 3.89-2.05c1.36-.45 2.66-.74 3.91-.87c1.33-.09 2.66-.04 4 .15c1.34.24 2.73.69 4.18 1.33c1.63.87 2.98 1.8 4.03 2.78c1.13 1.13 2.04 2.26 2.72 3.42c.59 1.03 1.12 2.23 1.57 3.62c.4 1.51.61 3.02.65 4.54l-.02.88zm61.17 2.2c.92-.09 1.72-.11 2.4-.07c1.61.12 2.98.75 4.13 1.89c.42.46.8 1.08 1.14 1.88c.25.65.4 1.56.46 2.73c.03 1.74-.51 3.26-1.61 4.57c-.3.39-.9.83-1.79 1.33c-.69.34-1.61.56-2.76.68c-1.76.11-3.32-.24-4.67-1.07c-1.3-.81-2.14-2.17-2.5-4.06c-.29-1.93-.01-3.63.84-5.09c.88-1.48 2.29-2.4 4.24-2.77l.12-.02zm-17.47.21l.55.1 .77.21c.81.31 1.54.73 2.18 1.25c1.01.77 1.62 2.17 1.84 4.2c.11 1.91-.4 3.51-1.53 4.78c-1.06 1.03-2.16 1.65-3.31 1.85l-.44.09-.99.11-5.62.01v-12.71c3.93-.02 6.11.01 6.55.11zm-27.88-.11l6.29 12.71-2.01-.01-1.55-3.13h-7.58l-1.54 3.13-1.98.01 6.29-12.71h2.08zm23.14 1.65v9.56h3.54c.77-.06 1.49-.21 2.18-.46c1.41-.77 2.2-1.79 2.39-3.08c.28-1.74.07-3.15-.63-4.21c-.7-.99-1.59-1.59-2.65-1.8c-.32-.17-1.93-.21-4.83-.11v.1zm-24.38.4l-2.94 6.01 6.24.02-3.1-6.37-.03-.02-.17.36zm-20.62.09l.71.07 .64.19c.74.29 1.36.79 1.88 1.49c.59.9.78 1.89.57 2.97l-.04.1c-.16.56-.42 1.1-.78 1.61c-.41.45-.9.83-1.48 1.14c-1.03.44-2.06.44-3.09.02l-.64-.35-.61-.51c-.53-.58-.88-1.24-1.06-1.99c-.2-1.03-.01-2.04.59-3l.47-.58 .67-.54c.57-.37 1.27-.58 2.11-.62h.06zm30.69 5.64v.22c.06.62.2 1.2.43 1.75c.3.45.67.83 1.1 1.13c.58.25 1.19.42 1.83.51c.78.02 1.51-.04 2.2-.17c1.37-.44 2.14-1.29 2.31-2.54c.08-.58.11-3.47.07-8.68h1.79l-.01 8.2c0 1.51-.69 2.77-2.06 3.77c-1.36.87-3.14 1.14-5.35.8c-1.8-.28-3.07-1.29-3.82-3.03l-.16-.57-.12-.84-.01-8.33h1.8v7.78zm41.75 1.97l.11-.15c.65-1 .95-2.08.92-3.23c-.01-1.27-.29-2.32-.82-3.14c-1.2-1.57-2.81-2.22-4.82-1.93c-1.99.22-3.29 1.38-3.89 3.48c-.25 1.23-.24 2.32.02 3.26c.32 1.11.84 1.93 1.56 2.46c.7.44 1.37.73 2.03.87c.89.08 1.76.05 2.59-.1c.59-.21 1.14-.49 1.66-.84l.31-.29 .33-.39zm-15.16 2.96v-12.71h1.8l-.01 12.71h-1.79z"/><g fill="#5AC1F9" stroke="#5AC1F9" stroke-width="0.3"><path fill-rule="evenodd" d="M112.82 24.1l3.74 7.55-1.2-.01-.92-1.86h-4.51l-.91 1.86-1.18.01 3.74-7.56 1.24.01zm-.74 1.21l-1.75 3.58 3.71.01-1.84-3.79-.12.2z"/><path d="M117.89 31.65v-7.56h2.94q.98 0 1.69.32q.7.31 1.08.91q.38.59.38 1.41q0 .81-.38 1.41q-.38.59-1.08.9q-.71.32-1.69.32h-2.36l.48-.51v2.8zm1.06-2.69l-.48-.53h2.33q1.04 0 1.57-.45q.54-.44.54-1.25q0-.82-.54-1.26q-.53-.45-1.57-.45h-2.33l.48-.53zM126.21 31.65v-7.56h2.95q.98 0 1.68.32q.71.31 1.09.91q.38.59.38 1.41q0 .81-.38 1.41q-.38.59-1.09.9q-.7.32-1.68.32h-2.36l.48-.51v2.8zm1.07-2.69l-.48-.53h2.33q1.03 0 1.57-.45q.53-.44.53-1.25q0-.82-.53-1.26q-.54-.45-1.57-.45h-2.33l.48-.53zM136.91 31.82q-.86 0-1.65-.26q-.79-.27-1.24-.69l.4-.83q.43.37 1.1.62q.67.25 1.39.25q.66 0 1.07-.15q.41-.16.61-.42q.19-.27.19-.6q0-.39-.25-.63q-.25-.24-.65-.38q-.41-.15-.9-.26q-.49-.11-.98-.25q-.49-.14-.89-.37q-.41-.23-.66-.61q-.25-.38-.25-.98q0-.59.31-1.08q.31-.49.95-.79q.65-.3 1.64-.3q.66 0 1.3.18q.65.18 1.13.5l-.36.85q-.49-.32-1.03-.47q-.54-.15-1.05-.15q-.63 0-1.04.17q-.41.16-.6.43q-.19.27-.19.61q0 .4.25.64q.25.24.65.38q.41.14.9.25q.49.12.98.26q.49.14.89.36q.41.22.66.6q.25.38.25.97q0 .58-.32 1.07q-.31.49-.96.79q-.65.29-1.65.29z"/></g></svg>'
const CHEV = '<svg class="lp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
const LENS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>'

const COUNTRIES = DATA.countries.map(([code, name, native, continents, languages], index) => ({
  code, name, native, index, continents: continents.split(','), languages: languages ? languages.split(',') : []
}))
const BY_CODE = new Map(COUNTRIES.map(c => [c.code, c]))
const DEFAULT_FLAGS = new URL('./flags.webp', import.meta.url).href

let worldPromise = null
const loadWorld = () => worldPromise || (worldPromise = import('./world.js').then(m => m.default))
let uidSeq = 0

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const el = (tag, cls, attrs) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k])
  return e
}

const injectStyle = () => {
  if (document.getElementById('lp-style')) return
  const s = el('style')
  s.id = 'lp-style'
  s.textContent = CSS
  document.head.append(s)
}

const setFlag = (node, c) => {
  const col = c.index % FLAGS.cols
  const row = Math.floor(c.index / FLAGS.cols)
  node.style.backgroundPosition = `${(col * 100) / (FLAGS.cols - 1)}% ${(row * 100) / (FLAGS.rows - 1)}%`
}

const flagEl = c => {
  const s = el('span', 'lp-flag', { 'aria-hidden': 'true' })
  setFlag(s, c)
  return s
}

export const version = VERSION
export const signature = SIGNATURE

export const countries = COUNTRIES.map(c => ({ code: c.code, name: c.name, native: c.native, continents: c.continents.slice(), languages: c.languages.slice() }))

const THEME_VARS = {
  accent: 'accent', ink: 'ink', muted: 'muted', faint: 'faint', line: 'line', panel: 'panel', sea: 'sea', land: 'land',
  country: 'country', border: 'border', dot: 'dot', hot: 'hot', hotDot: 'hot-dot', tint: 'tint', tintStrength: 'tint-strength',
  ease: 'ease', font: 'font', radius: 'radius'
}

export const themeKeys = Object.keys(THEME_VARS)

export function guessCountry(options = {}) {
  const ok = code => !options.allowed || options.allowed.has(code)
  const featured = (options.featured || []).map(c => BY_CODE.get(String(c).toUpperCase())).filter(c => c && ok(c.code))
  const wanted = options.from || (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [])
  for (const tag of wanted) {
    const parts = String(tag || '').split(/[-_]/)
    const region = parts.slice(1).find(p => /^[A-Za-z]{2}$/.test(p))
    if (region && BY_CODE.has(region.toUpperCase()) && ok(region.toUpperCase())) return region.toUpperCase()
    const lang = parts[0].toLowerCase()
    if (!lang) continue
    const hit = featured.find(c => c.languages.includes(lang)) ||
      (LANG_HOME[lang] && ok(LANG_HOME[lang]) && BY_CODE.get(LANG_HOME[lang])) ||
      COUNTRIES.find(c => c.languages[0] === lang && ok(c.code))
    if (hit) return hit.code
  }
  return null
}

export function createLangPicker(target, options = {}) {
  injectStyle()
  const o = { featured: [], code: 'country', align: 'end', ...options }
  const labels = { featured: 'Featured', search: 'Search country or language', button: 'Country and language', empty: 'No match', world: '', all: 'All', ...(o.labels || {}) }
  const uid = 'lp' + ++uidSeq
  const upper = a => (Array.isArray(a) ? a : []).map(x => String(x).toUpperCase())
  const regions = [...new Set(upper(o.regions).filter(r => CONTINENT_REGION[r]))]
  const include = upper(o.countries).length ? new Set(upper(o.countries)) : null
  const exclude = new Set(upper(o.exclude))
  const restricted = regions.length > 0 || !!include || exclude.size > 0
  const allowed = new Set(COUNTRIES.filter(c => (!include || include.has(c.code)) && !exclude.has(c.code) && (!regions.length || c.continents.some(x => regions.includes(x)))).map(c => c.code))
  const order = (regions.length ? regions : DATA.continents.map(x => x.code)).filter(g => COUNTRIES.some(c => allowed.has(c.code) && c.continents.includes(g)))
  const homeOf = c => c.continents.find(x => order.includes(x))
  const single = order.length === 1
  const inline = !!o.inline
  const storeKey = o.remember ? (typeof o.remember === 'string' ? o.remember : 'worldpicker') : null
  const featured = upper(o.featured).filter(c => allowed.has(c))
  let locale = o.locale || document.documentElement.lang || 'en'
  let stored = null
  try { stored = storeKey ? localStorage.getItem(storeKey) : null } catch (e) {}
  const guessed = guessCountry({ ...o, featured, allowed })
  let value = [stored, o.value && String(o.value).toUpperCase(), guessed, featured[0]].find(c => c && allowed.has(c)) || [...allowed][0] || 'GB'
  let tab = 'WORLD'
  let restrictedView = null
  let query = ''
  let world = null
  let svg = null
  let view = null
  let anim = 0
  let hotCode = null
  let touchPreview = null
  let rows = []
  let groupEls = []
  const shapes = new Map()
  const dots = []
  const labelOf = new Map()
  const keyOf = new Map()

  const root = el('div', 'lp', { 'data-wp-version': VERSION })
  root.append(document.createComment(` ${SIGNATURE} `))
  root.dataset.align = o.align
  root.style.setProperty('--lp-bgsize', `${FLAGS.cols * 100}% ${FLAGS.rows * 100}%`)
  if (o.globe === false) root.classList.add('lp-noglobe')
  if (inline) root.classList.add('lp-inline')
  if (single) root.classList.add('lp-single')
  const theme = o.theme || {}
  for (const k in theme) if (THEME_VARS[k] && theme[k] !== '' && theme[k] != null) root.style.setProperty('--lp-' + THEME_VARS[k], String(theme[k]))
  if (o.height) root.style.setProperty('--lp-height', typeof o.height === 'number' ? o.height + 'px' : String(o.height))

  const btn = el('button', 'lp-btn', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': uid + '-pop' })
  const btnFlag = el('span', 'lp-flag', { 'aria-hidden': 'true' })
  const btnCode = el('span', 'lp-btn-c')
  btn.append(btnFlag, btnCode)
  btn.insertAdjacentHTML('beforeend', CHEV)

  const pop = el('div', 'lp-pop', { id: uid + '-pop', role: 'dialog' })
  pop.hidden = true
  const mapbox = el('div', 'lp-mapbox')
  const tabsEl = el('div', 'lp-tabs')
  const mapEl = el('div', 'lp-map')
  const cap = el('div', 'lp-cap', { 'aria-hidden': 'true' })
  const capFlag = el('span', 'lp-flag')
  const capText = el('span', 'lp-cap-t')
  const capName = el('span', 'lp-cap-n')
  const capNative = el('bdi', 'lp-cap-x')
  capText.append(capName, ' ', capNative)
  cap.append(capFlag, capText)
  mapEl.append(cap)
  mapbox.append(tabsEl, mapEl)

  const side = el('div', 'lp-side')
  const search = el('label', 'lp-search')
  search.insertAdjacentHTML('afterbegin', LENS)
  const input = el('input', '', { type: 'search', autocomplete: 'off', spellcheck: 'false', 'aria-controls': uid + '-list' })
  search.append(input)
  const list = el('div', 'lp-list', { id: uid + '-list', role: 'listbox' })
  const empty = el('div', 'lp-empty', { role: 'status' })
  empty.hidden = true
  const foot = el('div', 'lp-foot')
  const credit = el('a', 'lp-credit', { href: CREDIT_HREF, target: '_blank', rel: 'noopener', title: SIGNATURE, 'aria-label': `World Picker ${CREDIT_TEXT}`, 'data-wp-credit': VERSION })
  credit.insertAdjacentHTML('afterbegin', BRAND_ICON)
  credit.append(CREDIT_TEXT)
  foot.append(credit)
  side.append(search, list, empty, foot)
  pop.append(mapbox, side)
  root.append(btn, pop)
  target.append(root)

  const country = () => BY_CODE.get(value)
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const narrow = () => window.matchMedia('(max-width: 640px)').matches
  const coarse = () => window.matchMedia('(hover: none)').matches

  const languageOf = c => {
    const supported = o.languages
    if (!supported) return c.languages[0] || null
    return c.languages.find(l => supported.includes(l)) || o.fallbackLanguage || supported[0] || null
  }

  const codeText = c => (o.code === 'none' ? '' : o.code === 'language' ? String(languageOf(c) || '').toUpperCase() : c.code)

  const detail = () => {
    const c = country()
    const language = languageOf(c)
    if (!labelOf.size) computeNames()
    return { country: c.code, language, locale: language ? `${language}-${c.code}` : null, name: labelOf.get(c.code), native: c.native }
  }

  const titleCase = s => (s ? s.charAt(0).toLocaleUpperCase(locale) + s.slice(1) : s)

  const regionNames = () => {
    try { return new Intl.DisplayNames([locale, 'en'], { type: 'region' }) } catch (e) { return null }
  }

  const languageNames = () => {
    try { return new Intl.DisplayNames([locale, 'en'], { type: 'language' }) } catch (e) { return null }
  }

  const continentName = (dn, key) => {
    const table = DATA.continentNames[locale] || DATA.continentNames[String(locale).split('-')[0]]
    const i = DATA.regionOrder.indexOf(key)
    if (table) return table[i]
    const region = key === 'WORLD' ? '001' : CONTINENT_REGION[key]
    try {
      const v = dn && dn.of(region)
      if (v && v !== region) return titleCase(v)
    } catch (e) {}
    return DATA.continentNames.en[i]
  }

  const tabTitle = (dn, key) => (key !== 'WORLD' ? continentName(dn, key) : restricted ? labels.all : labels.world || continentName(dn, key))

  function computeNames() {
    const dn = regionNames()
    const ln = languageNames()
    for (const c of COUNTRIES) {
      let name = c.name
      try {
        const v = dn && dn.of(c.code)
        if (v && v !== c.code) name = v
      } catch (e) {}
      labelOf.set(c.code, name)
      const langs = c.languages.map(l => {
        let local = ''
        try { local = ln ? ln.of(l) : '' } catch (e) {}
        return `${DATA.languages[l] || ''} ${local}`
      }).join(' ')
      keyOf.set(c.code, norm(`${name} ${c.name} ${c.native} ${c.code} ${langs}`))
    }
    return dn
  }

  function buildTabs(dn) {
    tabsEl.textContent = ''
    for (const key of single ? [] : ['WORLD', ...order]) {
      const t = el('button', 'lp-tab', { type: 'button', 'aria-pressed': String(key === tab) })
      t.dataset.tab = key
      t.textContent = tabTitle(dn, key)
      tabsEl.append(t)
    }
  }

  function buildRow(c, key, secondary) {
    const r = el('div', 'lp-o', { role: 'option', id: `${uid}-${key}-${c.code}`, tabindex: '-1', 'aria-selected': String(c.code === value) })
    r.dataset.cc = c.code
    r.dataset.g = key
    if (secondary) r.dataset.sec = '1'
    const t = el('span', 'lp-o-t')
    const n = el('span', 'lp-o-n')
    n.textContent = labelOf.get(c.code)
    t.append(n)
    if (!c.native || norm(c.native) === norm(labelOf.get(c.code))) r.classList.add('lp-o1')
    if (c.native && norm(c.native) !== norm(labelOf.get(c.code))) {
      const x = el('span', 'lp-o-x')
      const b = el('bdi')
      if (c.languages[0]) b.lang = c.languages[0]
      b.textContent = c.native
      x.append(b)
      t.append(x)
    }
    const k = el('span', 'lp-o-c')
    k.textContent = codeText(c)
    r.append(flagEl(c), t, k)
    return r
  }

  function buildList(dn) {
    list.textContent = ''
    rows = []
    groupEls = []
    const collator = new Intl.Collator(locale)
    const sorted = COUNTRIES.slice().sort((a, b) => collator.compare(labelOf.get(a.code), labelOf.get(b.code)))
    const groups = []
    if (featured.length) groups.push({ key: 'F', title: labels.featured, items: featured.map(cc => [BY_CODE.get(cc), false]) })
    for (const code of order) {
      groups.push({ key: code, title: continentName(dn, code), items: sorted.filter(c => allowed.has(c.code) && c.continents.includes(code)).map(c => [c, homeOf(c) !== code]) })
    }
    for (const g of groups) {
      const wrap = el('div', 'lp-g', { role: 'group' })
      const h = el('div', 'lp-h', { id: `${uid}-h-${g.key}` })
      h.textContent = g.title
      wrap.setAttribute('aria-labelledby', h.id)
      wrap.dataset.key = g.key
      wrap.append(h)
      for (const [c, secondary] of g.items) {
        const r = buildRow(c, g.key, secondary)
        wrap.append(r)
        rows.push(r)
      }
      list.append(wrap)
      groupEls.push(wrap)
    }
  }

  let rowsMeasured = false

  function measureRows() {
    if (rowsMeasured || pop.hidden || !list.clientWidth) return
    const two = COUNTRIES.find(c => c.native && norm(c.native) !== norm(labelOf.get(c.code))) || COUNTRIES[0]
    const one = COUNTRIES.find(c => !c.native || norm(c.native) === norm(labelOf.get(c.code))) || COUNTRIES[0]
    const probe = el('div', 'lp-probe', { 'aria-hidden': 'true' })
    const a = buildRow(two, 'P', false)
    const b = buildRow(one, 'P', false)
    a.removeAttribute('id')
    b.removeAttribute('id')
    a.removeAttribute('role')
    b.removeAttribute('role')
    probe.append(a, b)
    list.append(probe)
    const inner = r => {
      const cs = getComputedStyle(r)
      let h = parseFloat(cs.height)
      if (cs.boxSizing === 'border-box') h -= parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
      return h
    }
    const h2 = inner(a)
    const h1 = inner(b)
    probe.remove()
    if (h2 > 0) root.style.setProperty('--lp-row2', h2 + 'px')
    if (h1 > 0) root.style.setProperty('--lp-row1', h1 + 'px')
    rowsMeasured = true
  }

  function applyLabels() {
    input.placeholder = labels.search
    input.setAttribute('aria-label', labels.search)
    list.setAttribute('aria-label', labels.button)
    pop.setAttribute('aria-label', labels.button)
    empty.textContent = labels.empty
  }

  let built = false
  let spriteSet = false

  function loadSprite() {
    if (spriteSet) return
    spriteSet = true
    root.style.setProperty('--lp-sprite', `url("${o.flags || DEFAULT_FLAGS}")`)
  }

  function ensureBuilt() {
    if (built) return
    built = true
    loadSprite()
    rebuild()
  }

  function refresh() {
    if (built) return rebuild()
    applyLabels()
    updateButton()
  }

  function rebuild() {
    rowsMeasured = false
    const dn = computeNames()
    applyLabels()
    buildTabs(dn)
    buildList(dn)
    measureRows()
    filter()
    updateButton()
    showCaption(hotCode)
  }

  function updateButton() {
    const c = country()
    setFlag(btnFlag, c)
    btnCode.textContent = codeText(c)
    btn.setAttribute('aria-label', `${labels.button}: ${labelOf.get(c.code) || c.name}`)
  }

  const visibleRows = () => rows.filter(r => !r.hidden && !r.parentNode.hidden)

  let mapTimer = 0

  function highlightMap() {
    mapTimer = 0
    if (!svg) return
    const q = norm(query.trim())
    const searching = q.length > 0
    svg.classList.toggle('lp-filtering', searching)
    for (const [cc, node] of shapes) node.classList.toggle('match', searching && keyOf.get(cc).includes(q))
  }

  function filter(deferMap) {
    const q = norm(query.trim())
    const searching = q.length > 0
    for (const r of rows) {
      let show
      if (searching) show = r.dataset.g !== 'F' && !r.dataset.sec && keyOf.get(r.dataset.cc).includes(q)
      else if (tab === 'WORLD') show = !r.dataset.sec
      else show = r.dataset.g === tab
      if (r.hidden === show) r.hidden = !show
    }
    for (const g of groupEls) {
      const none = !g.querySelector('.lp-o:not([hidden])')
      if (g.hidden !== none) g.hidden = none
    }
    empty.hidden = rows.some(r => !r.hidden)
    clearTimeout(mapTimer)
    if (svg) {
      if (deferMap) mapTimer = setTimeout(highlightMap, 110)
      else highlightMap()
    }
    for (const t of tabsEl.children) t.setAttribute('aria-pressed', String(!searching && t.dataset.tab === tab))
  }

  function markSelected() {
    for (const r of rows) r.setAttribute('aria-selected', String(r.dataset.cc === value))
    for (const [cc, node] of shapes) node.classList.toggle('sel', cc === value)
    sizeDots()
  }

  function unitsPerPixel() {
    const w = svg.clientWidth || 1
    const h = svg.clientHeight || 1
    return 1 / Math.min(w / view[2], h / view[3])
  }

  function sizeDots() {
    if (!svg) return
    const u = unitsPerPixel()
    for (const d of dots) {
      const big = d.classList.contains('sel') || d.classList.contains('hot')
      d.setAttribute('r', ((big ? 4.6 : 3) * u).toFixed(3))
      d.setAttribute('stroke-width', (14 * u).toFixed(3))
    }
  }

  function applyView() {
    svg.setAttribute('viewBox', view.map(v => v.toFixed(2)).join(' '))
    sizeDots()
  }

  function targetView() {
    if (tab !== 'WORLD' && world.views[tab]) return world.views[tab].slice()
    return (restricted && restrictedView) || [0, 0, world.w, world.h]
  }

  function fitView() {
    const frames = order.map(g => world.views[g]).filter(Boolean)
    if (!frames.length) return null
    const fx0 = Math.min(...frames.map(f => f[0]))
    const fy0 = Math.min(...frames.map(f => f[1]))
    const fx1 = Math.max(...frames.map(f => f[0] + f[2]))
    const fy1 = Math.max(...frames.map(f => f[1] + f[3]))
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const node of shapes.values()) {
      let b
      try { b = node.getBBox() } catch (e) { continue }
      const bx0 = Math.max(b.x, fx0), by0 = Math.max(b.y, fy0)
      const bx1 = Math.min(b.x + b.width, fx1), by1 = Math.min(b.y + b.height, fy1)
      if (bx1 < bx0 || by1 < by0) continue
      x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0)
      x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1)
    }
    if (x0 === Infinity) return [fx0, fy0, fx1 - fx0, fy1 - fy0]
    const w = Math.max(x1 - x0, 40)
    const h = Math.max(y1 - y0, 24)
    const pad = Math.max(w, h) * 0.08
    return [(x0 + x1) / 2 - w / 2 - pad, (y0 + y1) / 2 - h / 2 - pad, w + 2 * pad, h + 2 * pad]
  }

  function zoom(animate) {
    if (!svg) return
    cancelAnimationFrame(anim)
    const to = targetView()
    const from = view.slice()
    if (!animate || reduced()) {
      view = to
      applyView()
      return
    }
    const t0 = performance.now()
    const step = now => {
      const k = Math.min(1, (now - t0) / 560)
      const e = 1 - Math.pow(1 - k, 3)
      view = from.map((v, i) => v + (to[i] - v) * e)
      applyView()
      if (k < 1) anim = requestAnimationFrame(step)
    }
    anim = requestAnimationFrame(step)
  }

  function buildMap(w) {
    world = w
    svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    const land = document.createElementNS(SVG_NS, 'path')
    land.setAttribute('class', 'lp-land')
    land.setAttribute('d', w.land)
    svg.append(land)
    for (const cc in w.shapes) {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', w.shapes[cc])
      if (allowed.has(cc)) {
        p.setAttribute('class', 'lp-c')
        p.dataset.cc = cc
        shapes.set(cc, p)
      } else {
        p.setAttribute('class', 'lp-land')
      }
      svg.append(p)
    }
    for (const cc in w.dots) {
      if (!allowed.has(cc)) continue
      const d = document.createElementNS(SVG_NS, 'circle')
      d.setAttribute('class', 'lp-c')
      d.setAttribute('cx', w.dots[cc][0])
      d.setAttribute('cy', w.dots[cc][1])
      d.dataset.cc = cc
      svg.append(d)
      shapes.set(cc, d)
      dots.push(d)
    }
    mapEl.prepend(svg)
    restrictedView = restricted ? fitView() : null
    view = targetView()
    filter()
    markSelected()
    applyView()
    showHot(hotCode)
  }

  function showCaption(cc) {
    const c = BY_CODE.get(cc || value)
    if (!c || !built) return
    setFlag(capFlag, c)
    capName.textContent = labelOf.get(c.code)
    const nat = c.native && norm(c.native) !== norm(labelOf.get(c.code)) ? c.native : ''
    capNative.textContent = nat
    capNative.lang = c.languages[0] || ''
  }

  function showHot(cc) {
    hotCode = cc
    for (const r of rows) r.classList.toggle('hot', r.dataset.cc === cc)
    for (const [code, node] of shapes) node.classList.toggle('hot', code === cc)
    sizeDots()
    showCaption(cc)
  }

  function rowFor(cc) {
    return visibleRows().find(r => r.dataset.cc === cc) || null
  }

  function scrollToRow(r, center) {
    if (!r) return
    const top = r.offsetTop
    const h = list.clientHeight
    if (center) list.scrollTop = top - h / 2 + r.offsetHeight / 2
    else if (top < list.scrollTop + 32) list.scrollTop = top - 32
    else if (top + r.offsetHeight > list.scrollTop + h) list.scrollTop = top + r.offsetHeight - h
  }

  function setTab(key) {
    tab = key
    const t = tabsEl.querySelector(`[data-tab="${key}"]`)
    if (t && tabsEl.scrollWidth > tabsEl.clientWidth) t.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    query = ''
    input.value = ''
    filter()
    list.scrollTop = 0
    zoom(true)
  }

  function open() {
    if (inline || !pop.hidden) return
    ensureBuilt()
    if (narrow()) root.style.setProperty('--lp-top', Math.round(btn.getBoundingClientRect().bottom + 8) + 'px')
    tab = 'WORLD'
    query = ''
    input.value = ''
    touchPreview = null
    pop.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    measureRows()
    filter()
    showHot(null)
    if (svg) zoom(false)
    else loadWorld().then(w => { if (!svg) buildMap(w) })
    const sel = rowFor(value)
    scrollToRow(sel, true)
    if (coarse()) (sel || btn).focus({ preventScroll: true })
    else input.focus({ preventScroll: true })
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onResize)
  }

  function close(returnFocus) {
    if (inline || pop.hidden) return
    pop.hidden = true
    cancelAnimationFrame(anim)
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('resize', onResize)
    if (returnFocus) btn.focus({ preventScroll: true })
  }

  function choose(cc) {
    if (!allowed.has(cc)) return
    const changed = cc !== value
    value = cc
    markSelected()
    updateButton()
    if (inline) showHot(null)
    else close(true)
    if (storeKey) {
      try { localStorage.setItem(storeKey, cc) } catch (e) {}
    }
    if (!changed) return
    const d = detail()
    if (o.onChange) o.onChange(d)
    root.dispatchEvent(new CustomEvent('lp-change', { detail: d, bubbles: true }))
    if (o.navigate) location.assign(String(o.navigate).replace(/\{(country|language|locale)\}/g, (m, k) => encodeURIComponent(d[k] || '')))
  }

  function onOutside(e) {
    if (!root.contains(e.target)) close(false)
  }

  function onResize() {
    rowsMeasured = false
    measureRows()
    if (narrow()) root.style.setProperty('--lp-top', Math.round(btn.getBoundingClientRect().bottom + 8) + 'px')
    if (svg) sizeDots()
  }

  function move(from, delta) {
    const vis = visibleRows()
    if (!vis.length) return
    let i = vis.indexOf(from)
    if (delta === 'first') i = 0
    else if (delta === 'last') i = vis.length - 1
    else if (i < 0) i = delta > 0 ? 0 : vis.length - 1
    else i = i + delta
    if (i < 0) {
      input.focus()
      return
    }
    const r = vis[Math.min(i, vis.length - 1)]
    r.focus({ preventScroll: true })
    scrollToRow(r, false)
  }

  btn.addEventListener('click', () => (pop.hidden ? open() : close(true)))
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      open()
    }
  })

  tabsEl.addEventListener('click', e => {
    const t = e.target.closest('.lp-tab')
    if (t) setTab(t.dataset.tab)
  })

  input.addEventListener('input', () => {
    query = input.value
    const scrolled = list.scrollTop !== 0
    filter(true)
    if (scrolled) list.scrollTop = 0
    if (svg && query.trim() && tab !== 'WORLD') {
      tab = 'WORLD'
      zoom(true)
    }
  })

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(null, 'first')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const first = visibleRows()[0]
      if (first) choose(first.dataset.cc)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (input.value) {
        input.value = ''
        query = ''
        filter()
      } else close(true)
    }
  })

  list.addEventListener('keydown', e => {
    const r = e.target.closest('.lp-o')
    if (e.key === 'ArrowDown') { e.preventDefault(); move(r, 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(r, -1) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(r, 8) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(r, -8) }
    else if (e.key === 'Home') { e.preventDefault(); move(r, 'first') }
    else if (e.key === 'End') { e.preventDefault(); move(r, 'last') }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (r) choose(r.dataset.cc) }
    else if (e.key === 'Escape') { e.preventDefault(); close(true) }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      input.focus()
      input.value += e.key
      query = input.value
      filter()
      list.scrollTop = 0
    }
  })

  list.addEventListener('click', e => {
    const r = e.target.closest('.lp-o')
    if (r) choose(r.dataset.cc)
  })
  list.addEventListener('mouseover', e => {
    const r = e.target.closest('.lp-o')
    if (r && r.dataset.cc !== hotCode) showHot(r.dataset.cc)
  })
  list.addEventListener('mouseleave', () => showHot(null))
  list.addEventListener('focusin', e => {
    const r = e.target.closest('.lp-o')
    if (r) showHot(r.dataset.cc)
  })

  let lastPointer = 'mouse'
  mapEl.addEventListener('pointerdown', e => { lastPointer = e.pointerType })
  mapEl.addEventListener('mouseover', e => {
    if (lastPointer === 'touch') return
    const t = e.target.closest('[data-cc]')
    if (!t || t.dataset.cc === hotCode) return
    showHot(t.dataset.cc)
    scrollToRow(rowFor(t.dataset.cc), true)
  })
  mapEl.addEventListener('mouseleave', () => { if (lastPointer !== 'touch') showHot(null) })
  mapEl.addEventListener('click', e => {
    const t = e.target.closest('[data-cc]')
    if (!t) return
    const cc = t.dataset.cc
    if (lastPointer === 'touch' && touchPreview !== cc) {
      touchPreview = cc
      showHot(cc)
      scrollToRow(rowFor(cc), true)
      return
    }
    choose(cc)
  })

  root.addEventListener('focusout', e => {
    if (!pop.hidden && e.relatedTarget && !root.contains(e.relatedTarget)) close(false)
  })

  if (inline) {
    ensureBuilt()
    pop.hidden = false
    measureRows()
    filter()
    scrollToRow(rowFor(value), true)
    loadWorld().then(w => { if (!svg) buildMap(w) })
    window.addEventListener('resize', onResize)
  } else {
    applyLabels()
    updateButton()
    const idleBuild = () => { if (root.isConnected) ensureBuilt() }
    const later = () => (window.requestIdleCallback ? requestIdleCallback(idleBuild, { timeout: 2500 }) : setTimeout(idleBuild, 300))
    if (document.readyState === 'complete') later()
    else window.addEventListener('load', later, { once: true })
    const warm = () => { loadSprite(); loadWorld() }
    btn.addEventListener('pointerenter', warm, { once: true })
    btn.addEventListener('focus', warm, { once: true })
  }

  return {
    element: root,
    get value() { return value },
    get detail() { return detail() },
    setValue(cc) {
      if (!allowed.has(cc)) return false
      value = cc
      markSelected()
      updateButton()
      showCaption(hotCode)
      return true
    },
    setLocale(next) {
      locale = next || 'en'
      labelOf.clear()
      refresh()
    },
    setLabels(next) {
      Object.assign(labels, next || {})
      refresh()
    },
    open,
    close: () => close(false),
    destroy() {
      close(false)
      cancelAnimationFrame(anim)
      clearTimeout(mapTimer)
      window.removeEventListener('resize', onResize)
      root.remove()
    }
  }
}

export async function mount(target, config) {
  let cfg = config
  if (typeof config === 'string') {
    const res = await fetch(config, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`worldpicker: ${config} returned ${res.status}`)
    cfg = await res.json()
  }
  return createLangPicker(target, cfg || {})
}

function autoMount() {
  for (const node of document.querySelectorAll('[data-worldpicker]')) {
    if (node.worldpickerMounted) continue
    node.worldpickerMounted = true
    const src = node.getAttribute('data-worldpicker')
    const json = node.querySelector('script[type="application/json"]')
    let config = src || {}
    if (!src && json) {
      try { config = JSON.parse(json.textContent) } catch (e) { console.error('worldpicker: invalid inline config', e) }
    }
    mount(node, config).then(picker => {
      node.worldpicker = picker
      node.dispatchEvent(new CustomEvent('lp-ready', { detail: picker, bubbles: true }))
    }).catch(e => console.error(e))
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount)
  else autoMount()
}

export default createLangPicker
