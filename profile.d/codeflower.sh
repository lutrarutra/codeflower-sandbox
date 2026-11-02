# Login shells (OpenCode's `!` shell, a user's `bash -l`) start from
# /etc/profile, which replaces the sandbox's PATH: the project's environment,
# /opt/codeflower/bin (codeflower-show, codeflower-open) and conda. The
# entrypoint keeps it in CODEFLOWER_SANDBOX_PATH, and this takes it back.
if [ -n "${CODEFLOWER_SANDBOX_PATH:-}" ]; then
  PATH="$CODEFLOWER_SANDBOX_PATH"
  export PATH
fi
