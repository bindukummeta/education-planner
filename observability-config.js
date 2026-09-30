// Public opt-in for browser error reports. Leave clientReports false until
// the host environment variable CLIENT_ERROR_REPORTS is exactly "on".
// Reports contain an error kind, a JavaScript error name, a file name, and a
// line. They do not contain messages, stacks, names, or page contents.
window.EDU_OBSERVABILITY = {
  clientReports: false
};
