#!/usr/bin/env python3
import sqlite3
import sys
import os

# 数据库路径
DB_PATH = "./data/db/common.db"

def update_version(new_version: str):
    """
    更新 system_config 表中 name='version' 对应的 value
    :param new_version: 新的版本号字符串
    """
    # 检查数据库文件是否存在
    if not os.path.exists(DB_PATH):
        print(f"❌ 数据库文件不存在：{DB_PATH}")
        return False

    try:
        # 连接数据库
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        # 执行更新：name = 'version' 的记录
        sql = """
            UPDATE system_config 
            SET value = ? 
            WHERE name = 'version'
        """
        cursor.execute(sql, (new_version,))
        conn.commit()

        # 检查是否更新成功
        if cursor.rowcount == 0:
            print("⚠️ 未找到 name='version' 的记录，未更新任何数据")
            return False

        print(f"✅ 更新成功！新版本号 = {new_version}")
        return True

    except sqlite3.OperationalError as e:
        print(f"❌ 数据库错误：{e}")
        return False
    except Exception as e:
        print(f"❌ 程序异常：{e}")
        return False
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    # 从命令行获取版本参数
    if len(sys.argv) < 2:
        print("用法示例：")
        print("   python update_version.py 2.1.0")
        sys.exit(1)

    new_version_str = sys.argv[1]
    update_version(new_version_str)

