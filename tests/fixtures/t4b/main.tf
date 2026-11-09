resource "aws_instance" "web" {
  ami       = "ami-123"
  subnet_id = "${aws_subnet.main.id}"
}

resource "aws_subnet" "main" {
  cidr_block = "10.0.0.0/24"
}
