import pg from 'pg';
const pool = new pg.Pool({
  connectionString: 'postgres://postgres:budQTGqhASnqCj3CoFZSVd0sXjn0sHdZ@hopper.proxy.rlwy.net:56852/railway',
});

const testId = `test_pg_fix_${Date.now()}`;

try {
  // 1. Insert a test position
  await pool.query(`
    INSERT INTO cfo_positions (id, strategy, asset, chain, cost_basis_usd, current_value_usd, unrealized_pnl_usd)
    VALUES ($1, 'polymarket', 'TEST', 'polygon', 100.0, 100.0, 0.0)
  `, [testId]);
  console.log('✅ INSERT ok');

  // 2. Run the FIXED query (PnL computed in JS, passed as $4)
  const costBasis = 100.0;
  const currentValueUsd = 115.50;
  const pnl = currentValueUsd - costBasis;
  await pool.query(`
    UPDATE cfo_positions
    SET current_price = $2, current_value_usd = $3,
        unrealized_pnl_usd = $4, updated_at = NOW()
    WHERE id = $1
  `, [testId, 1.155, currentValueUsd, pnl]);
  console.log('✅ UPDATE ok (new query)');

  // 3. Verify values
  const res = await pool.query('SELECT current_value_usd, unrealized_pnl_usd FROM cfo_positions WHERE id = $1', [testId]);
  const row = res.rows[0];
  console.log(`   current_value_usd = ${row.current_value_usd} (expect 115.5)`);
  console.log(`   unrealized_pnl_usd = ${row.unrealized_pnl_usd} (expect 15.5)`);

  if (Math.abs(row.unrealized_pnl_usd - 15.5) < 0.01) {
    console.log('✅ PnL correct');
  } else {
    console.log('❌ PnL mismatch!');
  }

  // 4. Confirm old query fails
  try {
    await pool.query(`
      UPDATE cfo_positions
      SET current_price = $2, current_value_usd = $3,
          unrealized_pnl_usd = $3::numeric - $4::numeric, updated_at = NOW()
      WHERE id = $1
    `, [testId, 1.155, currentValueUsd, costBasis]);
    console.log('⚠️  Old query succeeded (unexpected)');
  } catch (err: any) {
    console.log(`✅ Old query fails as expected: ${err.message.slice(0, 80)}`);
  }

  // 5. Cleanup
  await pool.query('DELETE FROM cfo_positions WHERE id = $1', [testId]);
  console.log('✅ Cleanup done');

} catch (err: any) {
  console.error('❌ Test failed:', err.message);
} finally {
  await pool.end();
}
