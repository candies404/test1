/**
 * 数据库保活脚本
 * 
 * 此脚本从环境变量中读取数据库连接信息和查询语句，
 * 然后依次执行每个查询以保持数据库连接活跃。
 * 
 * 环境变量 DB_CONNECTIONS 应包含一个 JSON 数组，格式如下:
 * [
 *   {
 *     "pgsql_url": "postgresql://username:password@hostname:port/database",
 *     "SQL_statement": "SELECT * FROM some_table;"
 *   },
 *   ...
 * ]
 */

const { Pool } = require('pg');

async function main() {
  try {
    // 从环境变量获取数据库连接配置
    const dbConnectionsJson = process.env.DB_CONNECTIONS;
    
    if (!dbConnectionsJson) {
      console.error('错误: 未设置 DB_CONNECTIONS 环境变量');
      process.exit(1);
    }
    
    // 解析 JSON 字符串为数组
    let connections;
    try {
      connections = JSON.parse(dbConnectionsJson);
    } catch (error) {
      console.error('错误: DB_CONNECTIONS 环境变量不是有效的 JSON 格式', error);
      process.exit(1);
    }
    
    if (!Array.isArray(connections)) {
      console.error('错误: DB_CONNECTIONS 应为数组格式');
      process.exit(1);
    }
    
    console.log(`发现 ${connections.length} 个数据库连接配置`);
    
    // 遍历处理每个数据库连接
    for (let i = 0; i < connections.length; i++) {
      const { pgsql_url, SQL_statement } = connections[i];
      
      if (!pgsql_url || !SQL_statement) {
        console.error(`警告: 连接 #${i + 1} 缺少必要参数，跳过`);
        continue;
      }
      
      console.log(`处理连接 #${i + 1}...`);
      
      // 创建数据库连接池
      const pool = new Pool({
        connectionString: pgsql_url,
        // 连接超时设置为10秒
        connectionTimeoutMillis: 10000,
      });
      
      try {
        // 获取客户端连接
        const client = await pool.connect();
        console.log(`成功连接到数据库 #${i + 1}`);
        
        try {
          // 执行查询语句
          console.log(`执行查询: ${SQL_statement}`);
          const result = await client.query(SQL_statement);
          console.log(`查询成功完成，返回 ${result.rowCount} 行数据`);
        } catch (queryError) {
          console.error(`查询执行失败:`, queryError.message);
        } finally {
          // 释放客户端连接
          client.release();
        }
      } catch (connectionError) {
        console.error(`连接数据库失败:`, connectionError.message);
      } finally {
        // 关闭连接池
        await pool.end();
      }
    }
    
    console.log('数据库保活任务已完成');
    
  } catch (error) {
    console.error('发生未知错误:', error);
    process.exit(1);
  }
}

// 执行主函数
main().catch(error => {
  console.error('执行失败:', error);
  process.exit(1);
});
