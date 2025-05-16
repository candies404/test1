/**
 * 数据库保活脚本 (文件配置版本)
 * 
 * 该脚本通过读取配置文件获取数据库配置信息，并执行指定的 SQL 查询语句
 * 配置格式为 JSON 数组，每个元素包含 Supabase URL、匿名密钥和要执行的 SQL 语句
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// 主函数
async function main() {
  try {
    // 配置文件路径，默认为当前目录下的 db-config.json
    const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'db-config.json');
    
    console.log(`正在读取配置文件: ${configPath}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(configPath)) {
      console.error(`错误: 配置文件不存在: ${configPath}`);
      process.exit(1);
    }
    
    // 读取并解析配置文件
    let dbConfigs;
    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      dbConfigs = JSON.parse(fileContent);
      
      if (!Array.isArray(dbConfigs)) {
        throw new Error('配置文件必须包含一个数组');
      }
    } catch (err) {
      console.error('错误: 读取或解析配置文件失败:', err.message);
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
