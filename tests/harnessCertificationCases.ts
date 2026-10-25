/** Shared certification cases: one correct and one wrong candidate per template. */
export interface CertCase {
  template: string;
  language: "python" | "cpp" | "rust";
  question: string;
  good: string;
  bad: string;
  ext?: string;
  compile?: string[];
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
  { template: "stdin.wrapper", language: "python", question: stdinQ,
    good: "n = int(input())\nprint(n * 2)", bad: "n = int(input())\nprint(n)" },
  { template: "stdin.wrapper", language: "cpp", question: stdinQ,
    good: "int main() { long long n; std::cin >> n; std::cout << n * 2; }",
    bad: "int main() { long long n; std::cin >> n; std::cout << n; }" },
  { template: "stdin.wrapper", language: "rust", question: stdinQ,
    good: "fn main() { let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n * 2); }",
    bad: "fn main() { let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n); }" },
];

