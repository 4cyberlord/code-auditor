/** Shared certification cases: one correct and one wrong candidate per template. */
export interface CertCase {
  template: string;
  language: "python" | "cpp" | "rust";
  question: string;
  good: string;
  bad: string;
  ext?: string;
  compile?: string[];
  minCases?: number;
}

const addQ = ["Add", "Example 1:", "Input: a = 2, b = 3", "Output: 5"].join("\n");
const twoQ = ["Two Sum", "Example 1:", "Input: nums = [2,7], target = 9", "Output: [0,1]"].join("\n");
const listQ = ["Reverse", "Example 1:", "Input: head = [1,2]", "Output: [2,1]"].join("\n");
const stdinQ = ["Double", "Example 1:", "Input: 3", "Read from standard input.", "Example 1:", "Input: 3", "Output: 6"].join("\n");

export const CERT_CASES: CertCase[] = [
  { template: "python.callable-scalar", language: "python", question: addQ,
    good: "def add(a, b):\n    return a + b", bad: "def add(a, b):\n    return a - b" },
  { template: "cpp.callable-scalar", language: "cpp", question: addQ,
    good: "int add(int a, int b) { return a + b; }", bad: "int add(int a, int b) { return a - b; }" },
  { template: "rust.callable-scalar", language: "rust", question: addQ,
    good: "pub fn add(a: i64, b: i64) -> i64 { a + b }", bad: "pub fn add(a: i64, b: i64) -> i64 { a - b }" },
  { template: "python.callable-vector", language: "python", question: twoQ,
    good: "def twoSum(nums, target):\n    return [0, 1]", bad: "def twoSum(nums, target):\n    return [1, 0]" },
  { template: "native.callable-vector", language: "cpp", question: twoQ,
    good: "class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {0,1}; } };",
    bad: "class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {1,0}; } };" },
  { template: "native.callable-vector", language: "rust", question: twoQ,
    good: "impl Solution { pub fn two_sum(n: Vec<i64>, t: i64) -> Vec<i64> { vec![0,1] } }",
    bad: "impl Solution { pub fn two_sum(n: Vec<i64>, t: i64) -> Vec<i64> { vec![1,0] } }" },
  { template: "callable-node", language: "python", question: listQ,
    good: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        prev=None\n        while head:\n            nxt=head.next; head.next=prev; prev=head; head=nxt\n        return prev",
    bad: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        return head" },
  { template: "callable-node", language: "cpp", question: listQ,
    good: "class Solution { public: ListNode* reverse(ListNode* h) { ListNode* p=nullptr; while(h){ ListNode* n=h->next; h->next=p; p=h; h=n; } return p; } };",
    bad: "class Solution { public: ListNode* reverse(ListNode* h) { return h; } };" },
  { template: "callable-node", language: "rust", question: listQ,
    good: "impl Solution { pub fn reverse(h: Option<Box<ListNode>>) -> Option<Box<ListNode>> { let mut p=None; let mut c=h; while let Some(mut n)=c { c=n.next.take(); n.next=p; p=Some(n); } p } }",
    bad: "impl Solution { pub fn reverse(h: Option<Box<ListNode>>) -> Option<Box<ListNode>> { h } }" },
  { template: "rust.callable-scalar", language: "rust", question: addQ,
    good: "pub fn add(a: i8, b: i8) -> u8 { (a + b) as u8 }", bad: "pub fn add(a: i8, b: i8) -> u8 { (a - b) as u8 }" },
  { template: "rust.callable-scalar", language: "rust", question: addQ,
    good: "pub fn add(a: isize, b: isize) -> i128 { (a + b) as i128 }", bad: "pub fn add(a: isize, b: isize) -> i128 { (a - b) as i128 }" },
  { template: "callable-node", language: "rust",
    question: ["Pop", "Example 1:", "Input: keep = [9], victim = [1,2]", "Output: [1]"].join("\n"),
    good: "impl Solution { pub fn pop(keep: Option<Box<ListNode>>, victim: &mut Option<Box<ListNode>>) { let _ = keep; let mut cur = victim; while let Some(node) = cur { if node.next.as_ref().map_or(true, |n| n.next.is_none()) { node.next = None; return; } cur = &mut node.next; } } }",
    bad: "impl Solution { pub fn pop(keep: Option<Box<ListNode>>, victim: &mut Option<Box<ListNode>>) { let _ = (keep, victim); } }" },
  // Multi-case coverage: nested arrays, tree gaps, optionals, mutation, unordered.
  { template: "native.callable-vector", language: "cpp", minCases: 2,
    question: ["Sum Grid", "Example 1:", "Input: grid = [[1,2],[3,4]]", "Output: 10",
      "Example 2:", "Input: grid = [[5],[6,7]]", "Output: 18"].join("\n"),
    good: "class Solution { public: int total(vector<vector<int>>& g) { int s=0; for (auto& r : g) for (int v : r) s += v; return s; } };",
    bad: "class Solution { public: int total(vector<vector<int>>& g) { return g.size(); } };" },
  { template: "callable-node", language: "rust", minCases: 2,
    question: ["Depth", "Example 1:", "Input: root = [1,null,2,3]", "Output: 3",
      "Example 2:", "Input: root = [1,null,2]", "Output: 2"].join("\n"),
    good: "impl Solution { pub fn depth(root: Option<Box<TreeNode>>) -> i64 { match root { None => 0, Some(n) => 1 + std::cmp::max(Self::depth(n.left), Self::depth(n.right)) } } }",
    bad: "impl Solution { pub fn depth(root: Option<Box<TreeNode>>) -> i64 { if root.is_some() { 1 } else { 0 } } }" },
  { template: "rust.callable-scalar", language: "rust", minCases: 2,
    question: ["Maybe", "Example 1:", "Input: n = 1", "Output: null", "Example 2:", "Input: n = 2", "Output: 4"].join("\n"),
    good: "pub fn maybe(n: i64) -> Option<i64> { if n == 1 { None } else { Some(n * 2) } }",
    bad: "pub fn maybe(n: i64) -> Option<i64> { Some(n) }" },
  { template: "callable-node", language: "rust", minCases: 2,
    question: ["Pop", "Example 1:", "Input: keep = [9], victim = [1,2]", "Output: [1]",
      "Example 2:", "Input: keep = [7], victim = [5,6,7]", "Output: [5,6]"].join("\n"),
    good: "impl Solution { pub fn pop(keep: Option<Box<ListNode>>, victim: &mut Option<Box<ListNode>>) { let _ = keep; let mut cur = victim; while let Some(node) = cur { if node.next.as_ref().map_or(true, |n| n.next.is_none()) { node.next = None; return; } cur = &mut node.next; } } }",
    bad: "impl Solution { pub fn pop(keep: Option<Box<ListNode>>, victim: &mut Option<Box<ListNode>>) { let _ = (keep, victim); } }" },
  { template: "python.callable-vector", language: "python", minCases: 2,
    question: ["Pairs", "Example 1:", "Input: nums = [1,2,3]", "Output: [[1,2],[2,3]]",
      "Example 2:", "Input: nums = [4,5]", "Output: [[4,5]]", "You may return the answer in any order."].join("\n"),
    good: "def pairs(nums):\n    return [[nums[i], nums[i+1]] for i in range(len(nums)-1)][::-1]",
    bad: "def pairs(nums):\n    return [[nums[i], nums[i+1]] for i in range(len(nums)-2)]" },
  { template: "stdin.wrapper", language: "python", question: stdinQ,
    good: "n = int(input())\nprint(n * 2)", bad: "n = int(input())\nprint(n)" },
  { template: "stdin.wrapper", language: "cpp", question: stdinQ,
    good: "int main() { long long n; std::cin >> n; std::cout << n * 2; }",
    bad: "int main() { long long n; std::cin >> n; std::cout << n; }" },
  { template: "stdin.wrapper", language: "rust", question: stdinQ,
    good: "fn main() { let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n * 2); }",
    bad: "fn main() { let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n); }" },
];

