import sys
import modules.ocr
from modules.config import init_config, version, data_dir, mybase_dir, server_port, force_index_target, ocr_disabled, ocr_mobile, workers_ocr, _single_user_mode, _shutdown_requested
from modules.database import init_common_db
from modules.search import ensure_indexes


def main():
    try:
        init_config()
        print("=" * 60)
        print(f"  Web of Mybase Knowledge Server  {version}")
        print("=" * 60)
        print(f"  Data directory: {data_dir}")
        print(f"  MyBase directory: {mybase_dir}")
        if force_index_target:
            print(f"  Force reindex: {force_index_target}")
        if ocr_disabled:
            print(f"  OCR disabled via --disable-ocr")
        elif ocr_mobile:
            print(f"  OCR model: mobile (lightweight)")
        else:
            print(f"  OCR model: server (high accuracy)")
        print(f"  Server URL: http://0.0.0.0:{server_port}")
        if _single_user_mode:
            print(f"  Single-user mode: login disabled (auto-admin)")
        print("=" * 60)

        if not ocr_disabled:
            modules.ocr.ocr_process_pool = modules.ocr.OCRProcessPool(workers_ocr)

        init_common_db()
        print("  Checking indexes...")
        ensure_indexes()
        print("  Done.")
        print("=" * 60)
        from modules.app import app, socketio
        socketio.run(app, host='0.0.0.0', port=server_port, debug=False, allow_unsafe_werkzeug=True)
    except KeyboardInterrupt:
        _shutdown_requested.set()
        ocr_pool = modules.ocr.ocr_process_pool
        if ocr_pool is not None:
            ocr_pool.shutdown()
        print("\n  [EXIT] Shutdown complete. Bye.")
        sys.exit(1)


if __name__ == '__main__':
    main()
