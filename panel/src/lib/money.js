/** An amount in rupees, Indian digit grouping: ₹1,23,456.78. */
export const rupees = (n, digits = 2) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
