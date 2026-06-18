import os
import sys
import contextlib


@contextlib.contextmanager
def suppress_stdout_stderr():
    try:
        stdout_fd = sys.stdout.fileno()
        stderr_fd = sys.stderr.fileno()
        old_stdout = os.dup(stdout_fd)
        old_stderr = os.dup(stderr_fd)
    except (OSError, AttributeError):
        with open(os.devnull, 'w', encoding='utf-8') as null:
            with contextlib.redirect_stdout(null), \
                 contextlib.redirect_stderr(null):
                yield
        return

    with open(os.devnull, 'wb') as devnull:
        os.dup2(devnull.fileno(), stdout_fd)
        os.dup2(devnull.fileno(), stderr_fd)

        try:
            yield
        finally:
            os.dup2(old_stdout, stdout_fd)
            os.dup2(old_stderr, stderr_fd)
            os.close(old_stdout)
            os.close(old_stderr)


def _get_current_sid():
    from flask import request as _flask_req
    try:
        return _flask_req.sid
    except (AttributeError, RuntimeError):
        pass
    try:
        return _flask_req.headers.get('X-Socket-ID')
    except RuntimeError:
        return None
