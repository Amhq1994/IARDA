// Modules that only run on the server (SMTP delivery); never reached in the browser demo.
export default {};
export const createTransport = () => { throw new Error("not available in the demo"); };
