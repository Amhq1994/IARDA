// node:path, node:os and node:url stand-ins for the browser demo.
export function join(...p: string[]) { return p.filter(Boolean).join("/").replace(/\/+/g, "/").replace(/\/\.\//g, "/"); }
export const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
export const resolve = join;
export const basename = (p: string) => p.split("/").pop() ?? "";
export const tmpdir = () => "/tmp";
export const fileURLToPath = (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname);
export const pathToFileURL = (p: string) => new URL(`file://${p}`);
export default { join, dirname, resolve, basename, tmpdir, fileURLToPath, pathToFileURL };
