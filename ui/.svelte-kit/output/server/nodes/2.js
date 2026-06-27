

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/2.Jf18o1xc.js","_app/immutable/chunks/CJf_8U9q.js","_app/immutable/chunks/xihTtKlq.js","_app/immutable/chunks/CGLJrnSn.js"];
export const stylesheets = ["_app/immutable/assets/2.CXv_Ct57.css"];
export const fonts = [];
