/* core/errors.js — typed errors. The shell catches ShellError subclasses
   and prints them as '<command>: <message>'; anything else is a bug. */

class ShellError extends Error {}
class FsError extends ShellError {}
class AuthError extends ShellError {}
class ConfigError extends ShellError {}
