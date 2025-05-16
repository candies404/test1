/**
 * 数据库保活脚本
 * 
 * 该脚本通过环境变量读取数据库配置信息，并执行指定的 SQL 查询语句
 * 配置格式为 JSON 数组，每个元素包含 Supabase URL、匿名密钥和要执行的 SQL 语句
 */

const { createClient } = require('@supabase/supabase-js');

// 主函数
async function main() {
  try {
    // 从环境变量获取数据库配置
    const dbConfigStr = process.env.DB_CONFIG;
    
    if (!dbConfigStr) {
      console.error('错误: 未找到 DB_CONFIG 环境变量');
      process.exit(1);
    }
    
    // 解析配置数组
    let dbConfigs;
    try {
      dbConfigs = JSON.parse(dbConfigStr);
      if (!Array.isArray(dbConfigs)) {
        throw new Error('DB_CONFIG 必须是一个数组');
      }
    } catch (err) {
      console.error('错误: 解析 DB_CONFIG 环境变量失败:', err.message);
      process.exit(1);
    }
    
    // 遍历配置数组并执行查询
    for (let i = 0; i < dbConfigs.length; i++) {
      const config = dbConfigs[i];
      console.log(`正在处理第 ${i + 1}/${dbConfigs.length} 个数据库配置...`);
      
      // 验证必要的配置项
      if (!config.EXPO_PUBLIC_SUPABASE_URL || !config.EXPO_PUBLIC_SUPABASE_ANON_KEY || !config.SQL_statement) {
        console.error(`配置 #${i + 1} 缺少必要的参数:`, JSON.stringify(config));
        continue;  // 跳过此配置，继续下一个
      }
      
      // 创建 Supabase 客户端
      const supabase = createClient(
        config.EXPO_PUBLIC_SUPABASE_URL,
        config.EXPO_PUBLIC_SUPABASE_ANON_KEY
      );
      
      // 执行查询
      try {
        console.log(`执行查询: ${config.SQL_statement}`);
        // 直接使用 Supabase 的 REST API 执行原始 SQL 查询
        const { data, error } = await supabase.from('rpc').select('*', { 
          head: false,
          count: 'exact'
        }).rpc('execute_sql', {
          sql_query: config.SQL_statement
        });
        
        if (error) {
          console.error(`查询 #${i + 1} 失败:`, error);
        } else {
          console.log(`查询 #${i + 1} 成功:`, data);
        }
      } catch (queryError) {
        console.error(`执行查询 #${i + 1} 时发生错误:`, queryError);
      }
    }
    
    console.log('所有数据库保活操作已完成');
  } catch (error) {
    console.error('脚本执行过程中发生错误:', error);
    process.exit(1);
  }
}

// 执行主函数
main().catch(err => {
  console.error('未捕获的错误:', err);
  process.exit(1);
});
