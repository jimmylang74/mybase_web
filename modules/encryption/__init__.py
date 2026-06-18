import os
import stat
from pathlib import Path
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes


def _encrypt_file_data(data: bytes, key: bytes) -> bytes:
    nonce = get_random_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(data)
    return nonce + ciphertext + tag


def _decrypt_file_data(encrypted: bytes, key: bytes) -> bytes:
    if len(encrypted) < 28:
        raise ValueError("数据损坏: 加密数据过短")
    nonce = encrypted[:12]
    tag = encrypted[-16:]
    ciphertext = encrypted[12:-16]
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    try:
        return cipher.decrypt_and_verify(ciphertext, tag)
    except (ValueError, KeyError) as e:
        raise ValueError(f"解密失败: {e}")


def _encrypt_file_at_path(file_path: Path, key: bytes) -> Path:
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    data = file_path.read_bytes()
    enc_data = _encrypt_file_data(data, key)
    enc_path.write_bytes(enc_data)
    file_path.unlink()
    return enc_path


def _decrypt_file_at_path(enc_path: Path, key: bytes) -> Path:
    if not enc_path.suffix.endswith('.enc'):
        return enc_path
    orig_suffix = enc_path.suffix[:-4]
    orig_path = enc_path.with_suffix(orig_suffix)
    data = enc_path.read_bytes()
    plain = _decrypt_file_data(data, key)
    orig_path.write_bytes(plain)
    enc_path.unlink()
    return orig_path


def _read_decrypted_file(file_path: Path, key: bytes) -> bytes:
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    if enc_path.exists():
        data = enc_path.read_bytes()
        return _decrypt_file_data(data, key)
    if file_path.exists():
        return file_path.read_bytes()
    raise FileNotFoundError(f"文件不存在: {file_path}")


def _write_encrypted_file(file_path: Path, data: bytes, key: bytes):
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    if file_path.exists():
        file_path.unlink()
    enc_data = _encrypt_file_data(data, key)
    enc_path.write_bytes(enc_data)


def _walk_tab_files(tab_name: str) -> list[Path]:
    from modules.tab import get_tab_path
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return []
    files = []
    for root, _dirs, filenames in os.walk(tab_path):
        for f in filenames:
            fp = Path(root) / f
            if fp.suffix == '.enc':
                continue
            if f.startswith('.'):
                continue
            if f == 'index.html' and fp.parent == tab_path:
                continue
            files.append(fp)
    return files


def _encrypt_all_tab_files(tab_name: str, key: bytes):
    files = _walk_tab_files(tab_name)
    for fp in files:
        try:
            _encrypt_file_at_path(fp, key)
        except Exception as e:
            from modules.config import log_error
            log_error("_encrypt_all_tab_files", e, f"{tab_name}/{fp.name}")


def _decrypt_all_tab_files(tab_name: str, key: bytes):
    from modules.tab import get_tab_path
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return
    for root, _dirs, filenames in os.walk(tab_path):
        for f in filenames:
            if not f.endswith('.enc'):
                continue
            enc_path = Path(root) / f
            try:
                _decrypt_file_at_path(enc_path, key)
            except Exception as e:
                from modules.config import log_error
                log_error("_decrypt_all_tab_files", e, f"{tab_name}/{f}")
