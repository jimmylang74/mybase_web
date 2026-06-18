import os
import re
import stat
import uuid
import base64
import tempfile
import threading
import multiprocessing as mp
from pathlib import Path

from modules.config import BASE_DIR, ocr_disabled, log_error, ocr_log
from modules.compat import suppress_stdout_stderr


# ─── OCR Process Pool ───────────────────────────────────────────────────

OCR_MODEL_DIR = BASE_DIR / 'models' / 'ocr'

ocr_process_pool: 'OCRProcessPool | None' = None


def _ocr_worker_init():
    OCR_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('PADDLE_PDX_CACHE_HOME', str(OCR_MODEL_DIR))
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    os.environ.setdefault('GLOG_v', '3')
    os.environ.setdefault('GLOG_logtostderr', '0')
    os.environ.setdefault('FLAGS_logtostderr', '0')
    os.environ.setdefault('FLAGS_log_dir', tempfile.gettempdir())
    os.environ['FLAGS_print_ir'] = '0'
    os.environ['FLAGS_log_level'] = '3'

    _use_mobile = os.environ.get('OCR_MOBILE', '1') == '1'

    from paddleocr import PaddleOCR
    try:
        import paddle as _paddle
        _paddle.disable_signal_handler()
    except (ImportError, AttributeError):
        pass

    _kwargs = dict(
        use_textline_orientation=True,
        lang='ch',
        device='cpu',
        enable_mkldnn=False,
        ocr_version="PP-OCRv5",
    )
    if _use_mobile:
        _kwargs['text_detection_model_name'] = "PP-OCRv5_mobile_det"
        _kwargs['text_recognition_model_name'] = "PP-OCRv5_mobile_rec"
    else:
        _kwargs['text_detection_model_name'] = "PP-OCRv5_server_det"
        _kwargs['text_recognition_model_name'] = "PP-OCRv5_server_rec"

    with suppress_stdout_stderr():
        return PaddleOCR(**_kwargs)


def _ocr_worker(task_queue, result_queue):
    import signal as _signal
    _signal.signal(_signal.SIGINT, _signal.SIG_IGN)

    try:
        _ocr = _ocr_worker_init()
    except BaseException as e:
        log_error("_ocr_worker.init", e, "PaddleOCR init failed, OCR disabled")
        return

    while True:
        try:
            task_id, image_path = task_queue.get()
        except (EOFError, OSError):
            break
        if task_id is None:
            break
        try:
            result_queue.put((task_id, None, time.monotonic()))
            result = _ocr.predict(str(image_path))
            texts = []
            if result:
                for page_result in result:
                    if page_result is None:
                        continue
                    rec_texts = page_result.get('rec_texts', [])
                    if rec_texts:
                        texts.extend(rec_texts)
            result_queue.put((task_id, ' '.join(texts)))
        except BaseException:
            result_queue.put((task_id, ''))


import time


class OCRProcessPool:
    def __init__(self, size: int):
        self._size = size
        self._task_queue = mp.Queue()
        self._result_queue = mp.Queue()
        self._processes: list[mp.Process] = []

        self._results: dict[str, str] = {}
        self._started: dict[str, float] = {}
        self._cv = threading.Condition()

        for _ in range(size):
            p = mp.Process(
                target=_ocr_worker,
                args=(self._task_queue, self._result_queue),
                daemon=True,
            )
            p.start()
            self._processes.append(p)

        self._collector = threading.Thread(target=self._collect_loop, daemon=True)
        self._collector.start()

        ocr_log(f"[OCR] 进程池启动: {size} 个进程")

    def _collect_loop(self) -> None:
        while True:
            try:
                msg = self._result_queue.get()
            except (EOFError, OSError):
                break
            with self._cv:
                if len(msg) == 3:
                    tid, _, start_time = msg
                    self._started[tid] = start_time
                else:
                    tid, text = msg
                    self._results[tid] = text
                    self._cv.notify_all()

    def predict_batch(
        self,
        image_paths: list[Path],
        batch_timeout: float = 300.0,
    ) -> list[str]:
        if not image_paths:
            return []

        task_ids = [str(uuid.uuid4()) for _ in image_paths]

        for tid, path in zip(task_ids, image_paths):
            self._task_queue.put((tid, str(path)))
            ocr_log(f"[OCR] 推理中: {path.name}")

        remaining_ids = set(task_ids)
        results: dict[str, str] = {}

        with self._cv:
            while remaining_ids:
                now = time.monotonic()

                for tid in list(remaining_ids):
                    if tid in self._started:
                        if now - self._started[tid] > batch_timeout:
                            self._started.pop(tid)
                            remaining_ids.discard(tid)

                for tid in list(remaining_ids):
                    if tid in self._results:
                        results[tid] = self._results.pop(tid)
                        self._started.pop(tid, None)
                        remaining_ids.discard(tid)

                if not remaining_ids:
                    break

                self._cv.wait(timeout=1.0)

            for tid in list(remaining_ids):
                if tid in self._results:
                    results[tid] = self._results.pop(tid)
                    remaining_ids.discard(tid)
                self._started.pop(tid, None)

        output: list[str] = []
        for tid, path in zip(task_ids, image_paths):
            text = results.get(tid, None)
            if text is not None:
                output.append(text)
                if text:
                    ocr_log(f"[OCR] 完成: {path.name}")
                else:
                    ocr_log(f"[OCR] 完成(无文本): {path.name}")
            else:
                output.append('')
                ocr_log(f"[OCR] 跳过(超时): {path.name}")
                print(f"  OCR timeout on {path.name}, skipping", flush=True)

        skipped = len(task_ids) - len(results)
        if skipped:
            print(f"  OCR batch: {skipped}/{len(task_ids)} timed out", flush=True)

        return output

    def shutdown(self) -> None:
        for _ in range(self._size):
            try:
                self._task_queue.put((None, None))
            except Exception:
                pass
        for p in self._processes:
            p.join(timeout=20)
            if p.is_alive():
                print(f"  [WARN] OCR worker (PID {p.pid}) did not exit within 20s, sending terminate()...", flush=True)
                p.terminate()


def resolve_image_path(img_src, tab_name):
    if not img_src or img_src.startswith('data:'):
        return None

    m = re.match(r'^/uploads/([^/]+)/images/(.+)$', img_src)
    if m:
        from modules.tab import get_tab_path
        tab_path = get_tab_path(m.group(1))
        if tab_path:
            return tab_path / 'images' / m.group(2)

    from modules.tab import get_tab_path
    tab_path = get_tab_path(tab_name)
    if tab_path:
        candidate = tab_path / img_src.lstrip('/')
        if candidate.exists():
            return candidate

    return None


def extract_text_from_html_images(html_content, tab_name):
    if ocr_disabled or not html_content:
        return ''
    img_pattern = re.compile(
        r'<img[^>]+src=[\'"]([^\'"]+)[\'"][^>]*>', re.IGNORECASE
    )

    image_paths = []
    temp_files = []

    for match in img_pattern.finditer(html_content):
        img_src = match.group(1)
        if not img_src:
            continue

        if img_src.startswith('data:'):
            m = re.match(r'^data:image/[^;]+;base64,(.+)$', img_src)
            if not m:
                continue
            try:
                img_data = base64.b64decode(m.group(1))
                with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                    f.write(img_data)
                    temp_path = f.name
                image_paths.append(Path(temp_path))
                temp_files.append(temp_path)
            except Exception as e:
                log_error("extract_text_from_html_images.decode", e)
            continue

        image_path = resolve_image_path(img_src, tab_name)
        if image_path and image_path.exists():
            image_paths.append(image_path)

    if not image_paths:
        return ''

    pool = ocr_process_pool
    if pool is None:
        return ''

    texts = pool.predict_batch(image_paths, batch_timeout=300.0)

    for tp in temp_files:
        try:
            if os.path.exists(tp):
                os.chmod(tp, stat.S_IWRITE)
                os.unlink(tp)
        except Exception as e:
            log_error("extract_text_from_html_images.cleanup", e)

    return ' '.join(t for t in texts if t).strip()
