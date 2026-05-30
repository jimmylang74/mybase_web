#!/usr/bin/env python3
import sqlite3
import os

# 数据库文件路径
DB_PATH = "./data/db/common.db"

def read_system_config():
    # 检查数据库文件是否存在
    if not os.path.exists(DB_PATH):
        print(f"错误：数据库文件不存在 → {DB_PATH}")
        return

    try:
        # 连接数据库
        conn = sqlite3.connect(DB_PATH)
        # 设置可以获取列名
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # 查询 system_config 表所有数据
        cursor.execute("SELECT * FROM system_config")
        rows = cursor.fetchall()

        if not rows:
            print("表 system_config 中没有数据")
            conn.close()
            return

        # 打印表头（列名）
        print("=" * 50)
        print("表：system_config")
        print("列名：", ", ".join(rows[0].keys()))
        print("=" * 50)

        # 打印每一行数据
        for idx, row in enumerate(rows, 1):
            print(f"\n第 {idx} 行数据：")
            # 遍历列名和对应的值
            for col_name in row.keys():
                value = row[col_name]
                print(f"  {col_name} = {value}")

    except sqlite3.OperationalError as e:
        print(f"数据库操作错误：{e}")
    except Exception as e:
        print(f"程序异常：{e}")
    finally:
        # 确保关闭连接
        if conn:
            conn.close()

if __name__ == "__main__":
    read_system_config()

